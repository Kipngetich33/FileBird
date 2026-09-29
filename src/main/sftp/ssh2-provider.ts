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
import { AppError, errnoOf } from '../errors'
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
import {
  TransferCancelled,
  type LinkStat,
  type RemoteFileStat,
  type SftpConnectOptions,
  type SftpProvider,
  type SftpTimeouts,
  type ShellOptions,
  type ShellSession,
  type TransferOptions,
  type UploadOptions
} from './sftp-provider'

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

/** Parallel chunk requests per transfer: measured 2–2.5× faster than streams (M6 plan D2). */
const TRANSFER_CONCURRENCY = 64
const TRANSFER_CHUNK_BYTES = 32_768

/** SFTP_FX_FAILURE: the server's catch-all, e.g. a full disk or a read-only file system. */
const SFTP_FAILURE = 4

/** How long to wait, after a transfer error, for the connection to report that it closed. */
const CLOSE_SETTLE_MS = 1_000

/** What $TERM says inside a shell: xterm.js speaks this, and servers have had it for years. */
const TERM_NAME = 'xterm-256color'

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

    const { host, port, username, auth } = options
    const client = new Client()
    this.client = client

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let ready = false

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(fromConnectError(error, host, port, auth.type) ?? error)
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

      const authMethods: AnyAuthMethod[] =
        auth.type === 'password'
          ? // Tried in order: many servers take passwords only via keyboard-interactive.
            [
              { type: 'password', username, password: auth.password },
              { type: 'keyboard-interactive', username, prompt: answerPasswordPrompt(auth.password) }
            ]
          : [{ type: 'publickey', username, key: auth.key, passphrase: auth.passphrase }]

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

  async stat(path: string): Promise<RemoteFileStat | null> {
    const sftp = this.requireSession()
    try {
      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(path, (error, result) => (error !== undefined ? reject(error) : resolve(result)))
      })
      return {
        kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size: stats.size,
        modifiedAt: typeof stats.mtime === 'number' ? stats.mtime * 1000 : null,
        mode: typeof stats.mode === 'number' ? stats.mode & 0o7777 : null
      }
    } catch (error) {
      if (sftpStatusOf(error) === SFTP_STATUS.NO_SUCH_FILE) return null
      throw this.toRequestError(error)
    }
  }

  upload(localPath: string, remotePath: string, { signal, onProgress, mode, modifiedAt }: UploadOptions): Promise<void> {
    return this.withTransferChannel('upload', signal, async (channel) => {
      await new Promise<void>((resolve, reject) => {
        channel.fastPut(
          localPath,
          remotePath,
          {
            concurrency: TRANSFER_CONCURRENCY,
            chunkSize: TRANSFER_CHUNK_BYTES,
            mode: mode & 0o777,
            step: (transferred, _chunk, total) => onProgress(transferred, total)
          },
          (error) => (error ? reject(error) : resolve())
        )
      })
      if (modifiedAt !== null) {
        const seconds = Math.floor(modifiedAt / 1000)
        await new Promise<void>((resolve, reject) => {
          channel.utimes(remotePath, seconds, seconds, (error) => (error ? reject(error) : resolve()))
        })
      }
    })
  }

  download(remotePath: string, localPath: string, { signal, onProgress }: TransferOptions): Promise<void> {
    return this.withTransferChannel('download', signal, (channel) =>
      new Promise<void>((resolve, reject) => {
        channel.fastGet(
          remotePath,
          localPath,
          {
            concurrency: TRANSFER_CONCURRENCY,
            chunkSize: TRANSFER_CHUNK_BYTES,
            step: (transferred, _chunk, total) => onProgress(transferred, total)
          },
          (error) => (error ? reject(error) : resolve())
        )
      })
    )
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = this.requireSession()
    const call = (fn: (cb: (error?: Error | null) => void) => void): Promise<void> =>
      new Promise((resolve, reject) => fn((error) => (error ? reject(error) : resolve())))
    try {
      // posix-rename replaces the target atomically; plain SFTP rename refuses an existing target.
      await call((cb) => sftp.ext_openssh_rename(from, to, cb))
    } catch (error) {
      if (!(error instanceof Error) || !/not support/i.test(error.message)) throw this.toRequestError(error)
      try {
        await call((cb) => sftp.rename(from, to, cb))
      } catch (renameError) {
        if (sftpStatusOf(renameError) !== SFTP_FAILURE || (await this.stat(to)) === null) throw this.toRequestError(renameError)
        // No atomic rename on this server: replace in two steps (only reached after the user chose Replace).
        await call((cb) => sftp.unlink(to, cb)).catch((unlinkError: unknown) => {
          throw this.toRequestError(unlinkError)
        })
        await call((cb) => sftp.rename(from, to, cb)).catch((retryError: unknown) => {
          throw this.toRequestError(retryError)
        })
      }
    }
  }

  async mkdir(path: string): Promise<'created' | 'exists'> {
    const sftp = this.requireSession()
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(path, (error) => (error ? reject(error) : resolve()))
      })
      return 'created'
    } catch (error) {
      // OpenSSH reports an existing name only as a generic failure; look.
      const existing = await this.stat(path).catch(() => null)
      if (existing?.kind === 'directory') return 'exists'
      if (existing !== null) throw new AppError('ALREADY_EXISTS', 'A file with this name already exists on the server.')
      throw this.toRequestError(error)
    }
  }

  async lstat(path: string): Promise<LinkStat | null> {
    const sftp = this.requireSession()
    try {
      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.lstat(path, (error, result) => (error !== undefined ? reject(error) : resolve(result)))
      })
      const isSymlink = stats.isSymbolicLink()
      return { kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other', isSymlink }
    } catch (error) {
      if (sftpStatusOf(error) === SFTP_STATUS.NO_SUCH_FILE) return null
      throw this.toRequestError(error)
    }
  }

  async renameNoReplace(from: string, to: string): Promise<void> {
    const sftp = this.requireSession()
    if ((await this.lstat(to)) !== null) throw new AppError('ALREADY_EXISTS', 'An item with this name already exists here.')
    try {
      // Plain SFTP rename refuses an existing target (unlike posix-rename, used for transfers).
      await new Promise<void>((resolve, reject) => {
        sftp.rename(from, to, (error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      if (sftpStatusOf(error) === SFTP_FAILURE && (await this.lstat(to)) !== null) {
        throw new AppError('ALREADY_EXISTS', 'An item with this name already exists here.')
      }
      throw this.toRequestError(error)
    }
  }

  removeDirectory(path: string): Promise<void> {
    const sftp = this.requireSession()
    return new Promise((resolve, reject) => {
      sftp.rmdir(path, (error) => (error ? reject(this.toRequestError(error)) : resolve()))
    })
  }

  remove(path: string): Promise<void> {
    const sftp = this.requireSession()
    return new Promise((resolve, reject) => {
      sftp.unlink(path, (error) => (error ? reject(this.toRequestError(error)) : resolve()))
    })
  }

  /**
   * Each transfer gets its own SFTP channel on the connection. Cancelling ends
   * only that channel (fastGet/fastPut have no abort of their own), and a large
   * transfer's parallel requests stay off the channel used for browsing.
   */
  private async withTransferChannel(
    direction: 'upload' | 'download',
    signal: AbortSignal,
    work: (channel: SFTPWrapper) => Promise<void>
  ): Promise<void> {
    const client = this.client
    if (client === null || this.sftp === null) throw notConnected()
    if (signal.aborted) throw new TransferCancelled()

    let channel: SFTPWrapper
    try {
      channel = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, opened) => (error !== undefined ? reject(error) : resolve(opened)))
      })
    } catch (error) {
      throw await this.toTransferError(error, direction, signal)
    }

    // A channel that fails later must never become an unhandled 'error' event.
    channel.on('error', (error: Error) => log.debug('Transfer channel error', { message: error.message }))
    const abort = (): void => channel.end()
    signal.addEventListener('abort', abort, { once: true })
    // When the connection drops, fastGet/fastPut never call back: their error
    // path waits for the server to confirm closing the remote handle over the
    // dead channel. The channel's own 'close' is the reliable signal.
    const closed = new Promise<never>((_resolve, reject) => {
      channel.once('close', () => reject(new Error('The transfer channel closed')))
    })
    closed.catch(() => undefined)
    try {
      await Promise.race([work(channel), closed])
    } catch (error) {
      throw await this.toTransferError(error, direction, signal)
    } finally {
      signal.removeEventListener('abort', abort)
      channel.end()
    }
  }

  private async toTransferError(error: unknown, direction: 'upload' | 'download', signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return new TransferCancelled()
    if (error instanceof AppError) return error

    // When the server drops the session, the transfer usually fails a moment
    // before the connection reports closing; give it a chance to catch up.
    const deadline = Date.now() + CLOSE_SETTLE_MS
    while (this.sftp !== null && Date.now() < deadline && sftpStatusOf(error) === undefined && errnoOf(error) !== 'ENOSPC') {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (this.sftp === null) return this.endRequested ? notConnected() : connectionLost()

    switch (errnoOf(error)) {
      case 'ENOSPC':
        return new AppError('DISK_FULL', "There isn't enough space on this computer for this file.")
      case 'EACCES':
      case 'EPERM':
        return new AppError(
          'PERMISSION_DENIED',
          direction === 'download' ? "You don't have permission to write to this folder." : "You don't have permission to read this file."
        )
      case 'ENOENT':
        return new AppError('NOT_FOUND', 'The file or folder no longer exists.')
    }

    switch (sftpStatusOf(error)) {
      case SFTP_STATUS.NO_SUCH_FILE:
        return new AppError('NOT_FOUND', 'The file or folder no longer exists on the server.')
      case SFTP_STATUS.PERMISSION_DENIED:
        return new AppError(
          'PERMISSION_DENIED',
          direction === 'upload'
            ? "You don't have permission to write to this folder on the server."
            : "You don't have permission to read this file on the server."
        )
      case SFTP_FAILURE:
        return new AppError(
          'TRANSFER_FAILED',
          direction === 'upload'
            ? "The server couldn't save the file. It may be full or read-only."
            : "The server couldn't send the file."
        )
    }
    return error
  }

  /**
   * An interactive shell on this connection (Milestone 11 plan D2).
   *
   * The pseudo-terminal is sized in characters; the pixel size is left at zero,
   * because ssh2 ignores it when rows and columns are given.
   */
  openShell({ cols, rows, handlers }: ShellOptions): Promise<ShellSession> {
    const client = this.client
    if (client === null || this.sftp === null) return Promise.reject(notConnected())

    return new Promise<ShellSession>((resolve, reject) => {
      client.shell({ term: TERM_NAME, cols, rows, width: 0, height: 0 }, {}, (error, stream) => {
        if (error !== undefined) {
          reject(this.toRequestError(error))
          return
        }

        let ended = false
        const end = (code: number | null, signal: string | null): void => {
          if (ended) return
          ended = true
          handlers.onClose({ code, signal })
        }

        stream.on('data', (chunk: Buffer) => handlers.onData(chunk))
        // A pty merges the server's stderr into its output, but an unread stream
        // would still fill up, so it is drained into the same place.
        stream.stderr.on('data', (chunk: Buffer) => handlers.onData(chunk))
        // 'exit' is optional in the SSH protocol, so 'close' is what settles it.
        stream.on('exit', (code: number | null, signal?: string) => end(typeof code === 'number' ? code : null, signal ?? null))
        stream.on('close', () => end(null, null))
        // A channel error must never reach the process as an unhandled event.
        stream.on('error', (channelError: Error) => {
          log.warn('Shell channel error', { message: channelError.message })
          end(null, null)
        })

        resolve({
          write: (data) => {
            if (!ended) stream.write(Buffer.from(data))
          },
          // setWindow takes rows before columns, the opposite way round to the terminal.
          resize: (nextCols, nextRows) => {
            if (!ended) stream.setWindow(nextRows, nextCols, 0, 0)
          },
          setFlowing: (flowing) => {
            if (ended) return
            // Pausing stops ssh2 extending the channel's window, so the server
            // itself stops sending rather than the output piling up here.
            if (flowing) stream.resume()
            else stream.pause()
          },
          close: () => {
            if (ended) return
            // ssh2's destroy() sends EOF and closes this channel only.
            stream.destroy()
          }
        })
      })
    })
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
