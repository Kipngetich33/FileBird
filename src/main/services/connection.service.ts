import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type {
  ConnectOutcome,
  ConnectRequest,
  ConnectionClosedEvent,
  ConnectionInfo
} from '../../shared/types/connection'
import type { DirectoryListing } from '../../shared/types/files'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import { type HostKeyStore, describeHostKey } from '../sftp/host-keys'
import { notConnected } from '../sftp/sftp-errors'
import type { SftpAuth, SftpProvider } from '../sftp/sftp-provider'
import { loadPrivateKey } from '../ssh/private-keys'

const log = createLogger('connections')

/** How long a "trust this host key?" question stays answerable. */
const PENDING_TTL_MS = 2 * 60_000

export interface ConnectHooks {
  /**
   * Runs once the connection is ready, whether directly or after a host key was
   * trusted. A returned string is passed to the renderer as a notice. Failures
   * are logged and reported as a notice; they never undo the connection.
   */
  onConnected?: (connection: ConnectionInfo) => Promise<string | undefined>
}

interface PendingTrust {
  /** Includes the password or passphrase, so it must not outlive its expiry. */
  request: ConnectRequest
  hooks: ConnectHooks
  key: Buffer
  expiresAt: number
  /** Deletes the entry at expiry even if the user never answers. */
  timer: ReturnType<typeof setTimeout>
}

interface ActiveConnection {
  info: ConnectionInfo
  provider: SftpProvider
}

export interface ConnectionServiceOptions {
  hostKeys: HostKeyStore
  createProvider: () => SftpProvider
  onConnectionClosed: (event: ConnectionClosedEvent) => void
  loadKey?: (path: string, passphrase?: string) => Promise<Buffer>
  pendingTtlMs?: number
  now?: () => number
}

/**
 * Owns every remote connection (spec section 16: connection state lives in
 * the main process). The renderer only ever holds a connection id.
 *
 * Host keys are trusted on first use. An unknown key is never accepted during
 * the handshake: the connection is refused, the key is held here against a
 * single-use token, and only after the user confirms is it stored and the
 * connection retried, requiring that exact key.
 */
export class ConnectionService {
  private readonly options: ConnectionServiceOptions
  private readonly now: () => number
  private readonly connections = new Map<string, ActiveConnection>()
  private readonly pending = new Map<string, PendingTrust>()

  constructor(options: ConnectionServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  async connect(request: ConnectRequest, hooks: ConnectHooks = {}): Promise<ConnectOutcome> {
    const { host, port } = request
    // Local checks first: a missing key file or a wrong passphrase is reported
    // before anything touches the network.
    const auth = await this.resolveAuth(request)
    const saved = await this.options.hostKeys.lookup(host, port)
    const offered: { key: Buffer | null } = { key: null }
    const provider = this.options.createProvider()

    try {
      await provider.connect({
        host,
        port,
        username: request.username,
        auth,
        verifyHostKey: (key) => {
          offered.key = Buffer.from(key)
          return saved !== null && saved.equals(key)
        }
      })
    } catch (error) {
      const key = offered.key
      // Refused because of the host key, not for any other reason.
      if (key !== null && (saved === null || !saved.equals(key))) {
        if (saved === null) {
          const token = randomUUID()
          const ttl = this.options.pendingTtlMs ?? PENDING_TTL_MS
          this.prunePending()
          const timer = setTimeout(() => this.pending.delete(token), ttl)
          // Never keep the app alive just to expire a question.
          timer.unref()
          this.pending.set(token, { request, hooks, key, expiresAt: this.now() + ttl, timer })
          return { status: 'host-key-unknown', token, host, port, hostKey: describeHostKey(key) }
        }
        log.warn('Host key changed; connection refused', { host, port })
        return {
          status: 'host-key-changed',
          host,
          port,
          saved: describeHostKey(saved),
          offered: describeHostKey(key)
        }
      }
      throw error
    }

    const connection = await this.register(provider, request)
    const notice = await this.afterConnected(hooks, connection)
    return notice === undefined ? { status: 'connected', connection } : { status: 'connected', connection, notice }
  }

  /** Stores exactly the key the main process saw for this token, then connects requiring it. */
  async trustHostKeyAndConnect(token: string): Promise<ConnectOutcome> {
    this.prunePending()
    const pending = this.pending.get(token)
    this.pending.delete(token)
    if (pending !== undefined) clearTimeout(pending.timer)
    if (pending === undefined) {
      throw new AppError('INVALID_INPUT', 'This confirmation has expired. Connect again to continue.')
    }

    const { request, hooks, key } = pending
    await this.options.hostKeys.trust(request.host, request.port, key)
    log.info('Host key trusted', { host: request.host, port: request.port, ...describeHostKey(key) })
    return this.connect(request, hooks)
  }

  forgetHostKey(host: string, port: number): Promise<void> {
    log.info('Host key forgotten', { host, port })
    return this.options.hostKeys.forget(host, port)
  }

  /** The live provider for a connection, for transfers. Throws NOT_CONNECTED. */
  providerFor(connectionId: string): SftpProvider {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) throw notConnected()
    return connection.provider
  }

  /** Who a live connection is to, or null once it has closed. */
  serverOf(connectionId: string): { host: string; port: number; username: string } | null {
    const info = this.connections.get(connectionId)?.info
    return info === undefined ? null : { host: info.host, port: info.port, username: info.username }
  }

  /** The remote home folder of a live connection, or null once it has closed. */
  homeOf(connectionId: string): string | null {
    return this.connections.get(connectionId)?.info.homePath ?? null
  }

  /** A live connection to this server as this user, e.g. to retry transfers after reconnecting. */
  findLive(server: { host: string; port: number; username: string }): string | null {
    for (const { info } of this.connections.values()) {
      if (info.host === server.host && info.port === server.port && info.username === server.username) return info.id
    }
    return null
  }

  async list(connectionId: string, path: string): Promise<DirectoryListing> {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) throw notConnected()
    const entries = await connection.provider.list(path)
    return { path, parentPath: path === '/' ? null : posix.dirname(path), entries }
  }

  /** Idempotent: disconnecting an unknown or closed connection is not an error. */
  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    this.connections.delete(connectionId)
    await connection.provider.disconnect()
    log.info('Disconnected', { host: connection.info.host, port: connection.info.port })
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  private async register(provider: SftpProvider, request: ConnectRequest): Promise<ConnectionInfo> {
    let homePath: string
    try {
      homePath = await provider.realpath('.')
    } catch (error) {
      await provider.disconnect()
      throw error
    }

    const info: ConnectionInfo = {
      id: randomUUID(),
      host: request.host,
      port: request.port,
      username: request.username,
      homePath
    }
    this.connections.set(info.id, { info, provider })

    provider.onUnexpectedClose((error) => {
      if (!this.connections.delete(info.id)) return
      this.options.onConnectionClosed({ connectionId: info.id, code: 'CONNECTION_LOST', message: error.message })
    })

    log.info('Connected', { host: info.host, port: info.port })
    return info
  }

  private async resolveAuth(request: ConnectRequest): Promise<SftpAuth> {
    if (request.auth.type === 'password') return { type: 'password', password: request.auth.password }
    const load = this.options.loadKey ?? loadPrivateKey
    const key = await load(request.auth.privateKeyPath, request.auth.passphrase)
    return { type: 'privateKey', key, passphrase: request.auth.passphrase }
  }

  private async afterConnected(hooks: ConnectHooks, connection: ConnectionInfo): Promise<string | undefined> {
    if (hooks.onConnected === undefined) return undefined
    try {
      return await hooks.onConnected(connection)
    } catch (error) {
      log.warn('After-connect step failed', { error: error instanceof Error ? error.message : String(error) })
      return 'Connected, but a follow-up step failed. See the log for details.'
    }
  }

  private prunePending(): void {
    const now = this.now()
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        clearTimeout(entry.timer)
        this.pending.delete(token)
      }
    }
  }
}
