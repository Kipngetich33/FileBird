import {
  Client,
  type AnyAuthMethod,
  type ClientErrorExtensions,
  type FileEntryWithStats,
  type KeyboardInteractiveCallback,
  type Prompt,
  type SFTPWrapper,
  type Stats
} from 'ssh2'
import type { FileEntry } from '../../shared/types/files'
import type { AppError } from '../errors'
import { createLogger } from '../logger'
import { mapLimit } from '../utils/map-limit'
import { toRemoteEntry } from './remote-entries'
import {
  SFTP_STATUS,
  connectionLost,
  fromConnectError,
  fromSftpError,
  notADirectory,
  notConnected,
  sftpStatusOf
} from './sftp-errors'
import type { SftpConnectOptions, SftpProvider, SftpTimeouts } from './sftp-provider'

const log = createLogger('sftp')

export const DEFAULT_TIMEOUTS: SftpTimeouts = {
  readyMs: 20_000,
  keepaliveIntervalMs: 10_000,
  keepaliveCountMax: 3
}

/** Symlink targets are stat'ed with bounded concurrency, so a folder of hundreds of links can't flood the session. */
const STAT_CONCURRENCY = 16

/** How long a polite disconnect may take before the socket is torn down. */
const DISCONNECT_GRACE_MS = 3_000

type SshError = Error & ClientErrorExtensions

/**
 * Keyboard-interactive login with the user's password, but only for what is
 * plainly a password prompt: one prompt, hidden input, asked once. Anything
 * else (one-time codes, several questions) is answered with nothing, so the
 * attempt fails instead of sending the password to an unexpected question.
 */
function answerPasswordPrompt(password: string) {
  let answered = false
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Prompt[],
    finish: KeyboardInteractiveCallback
  ): void => {
    if (!answered && prompts.length === 1 && prompts[0]?.echo === false) {
      answered = true
      finish([password])
      return
    }
    finish([])
  }
}

/** One connection's worth of ssh2. Create a new provider for each connection. */
export class Ssh2SftpProvider implements SftpProvider {
  private readonly timeouts: SftpTimeouts
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private used = false
  private endRequested = false
  private readonly closeListeners: Array<(error: AppError) => void> = []

  constructor(timeouts: Partial<SftpTimeouts> = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts }
  }

  connect(options: SftpConnectOptions): Promise<void> {
    if (this.used) return Promise.reject(new Error('Ssh2SftpProvider instances are single-use'))
    this.used = true

    const { host, port, username, password } = options
    const client = new Client()
    this.client = client

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let ready = false

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(fromConnectError(error, host, port) ?? error)
        client.end()
      }

      // ssh2 can emit 'error' more than once for one connection (a handshake
      // timeout is followed by "Connection lost before handshake"). An 'error'
      // event with no listener crashes the main process, so this listener stays
      // attached for the client's whole lifetime.
      client.on('error', (error: SshError) => {
        if (!ready) {
          fail(error)
          return
        }
        log.warn('Connection error', { host, port, message: error.message, level: error.level })
      })

      client.on('close', () => {
        this.client = null
        this.sftp = null
        if (!ready) {
          fail(new Error('Connection lost before handshake'))
          return
        }
        if (!this.endRequested) {
          log.warn('Connection closed unexpectedly', { host, port })
          this.emitUnexpectedClose()
        }
      })

      client.on('ready', () => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            fail(error)
            return
          }
          if (settled) return
          // The SFTP channel can close while SSH stays up; treat that as the
          // connection going away rather than leaving a half-open session.
          sftp.on('close', () => {
            if (!this.endRequested) client.end()
          })
          this.sftp = sftp
          ready = true
          settled = true
          resolve()
        })
      })

      // Tried in order: many servers take passwords only via keyboard-interactive.
      const authMethods: AnyAuthMethod[] = [
        { type: 'password', username, password },
        { type: 'keyboard-interactive', username, prompt: answerPasswordPrompt(password) }
      ]

      try {
        client.connect({
          host,
          port,
          username,
          readyTimeout: this.timeouts.readyMs,
          keepaliveInterval: this.timeouts.keepaliveIntervalMs,
          keepaliveCountMax: this.timeouts.keepaliveCountMax,
          hostVerifier: (key: Buffer) => options.verifyHostKey(key),
          authHandler: authMethods
        })
      } catch (error) {
        fail(error)
      }
    })
  }

  realpath(path: string): Promise<string> {
    const sftp = this.requireSession()
    return new Promise((resolve, reject) => {
      sftp.realpath(path, (error, absolute) => {
        if (error !== undefined) reject(this.toRequestError(error))
        else resolve(absolute)
      })
    })
  }

  async list(path: string): Promise<FileEntry[]> {
    const sftp = this.requireSession()

    let raw: FileEntryWithStats[]
    try {
      raw = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(path, (error, list) => (error !== undefined ? reject(error) : resolve(list)))
      })
    } catch (error) {
      // SFTP reports "file" and "missing" with the same status; stat tells them apart.
      if (sftpStatusOf(error) === SFTP_STATUS.NO_SUCH_FILE && (await this.isNotADirectory(sftp, path))) {
        throw notADirectory()
      }
      throw this.toRequestError(error)
    }

    const statTarget = (target: string): Promise<Stats> =>
      new Promise((resolve, reject) => {
        sftp.stat(target, (error, stats) => (error !== undefined ? reject(error) : resolve(stats)))
      })

    const entries = raw.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
    return mapLimit(entries, STAT_CONCURRENCY, (entry) => toRemoteEntry(path, entry, statTarget))
  }

  async disconnect(): Promise<void> {
    this.endRequested = true
    const client = this.client
    if (client === null) return

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        client.destroy()
        resolve()
      }, DISCONNECT_GRACE_MS)
      client.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      client.end()
    })
  }

  onUnexpectedClose(listener: (error: AppError) => void): void {
    this.closeListeners.push(listener)
  }

  private emitUnexpectedClose(): void {
    const error = connectionLost()
    for (const listener of this.closeListeners.splice(0)) listener(error)
  }

  private requireSession(): SFTPWrapper {
    if (this.sftp === null) throw notConnected()
    return this.sftp
  }

  /** A request that failed because the session vanished is a lost connection, not an SFTP error. */
  private toRequestError(error: unknown): unknown {
    if (this.sftp === null && !this.endRequested) return connectionLost()
    if (this.sftp === null) return notConnected()
    return fromSftpError(error) ?? error
  }

  private isNotADirectory(sftp: SFTPWrapper, path: string): Promise<boolean> {
    return new Promise((resolve) => {
      sftp.stat(path, (error, stats) => resolve(error === undefined && !stats.isDirectory()))
    })
  }
}
