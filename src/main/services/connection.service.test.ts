import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectRequest, ConnectionClosedEvent } from '../../shared/types/connection'
import type { FileEntry } from '../../shared/types/files'
import { AppError } from '../errors'
import { HostKeyStore, hostKeyFingerprint } from '../sftp/host-keys'
import type { RemoteFileStat, SftpConnectOptions, SftpProvider } from '../sftp/sftp-provider'
import { ConnectionService } from './connection.service'

const KEY_A = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIL+WK19nFj1HtD6rGNBy0QNPm3X4T66kM+3LiYvnV0ba', 'base64')
const KEY_B = Buffer.concat([KEY_A.subarray(0, -1), Buffer.from([0x01])])

const REQUEST: ConnectRequest = {
  host: 'example.com',
  port: 22,
  username: 'ubuntu',
  auth: { type: 'password', password: 'hunter2' }
}

/** Stands in for a server: presents a key, then succeeds or fails as told. */
class FakeProvider implements SftpProvider {
  connected = false
  disconnects = 0
  seenOptions: SftpConnectOptions | null = null
  private closeListener: ((error: AppError) => void) | null = null
  private readonly server: FakeServer

  constructor(server: FakeServer) {
    this.server = server
  }

  async connect(options: SftpConnectOptions): Promise<void> {
    this.seenOptions = options
    if (!options.verifyHostKey(this.server.key)) throw new AppError('HANDSHAKE_FAILED', 'refused')
    if (this.server.failWith !== undefined) throw this.server.failWith
    this.connected = true
  }

  async realpath(): Promise<string> {
    if (this.server.realpathFails) throw new AppError('PERMISSION_DENIED', 'nope')
    return '/home/ubuntu'
  }

  async list(): Promise<FileEntry[]> {
    return []
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
    this.connected = false
  }

  onUnexpectedClose(listener: (error: AppError) => void): void {
    this.closeListener = listener
  }

  simulateNetworkLoss(): void {
    this.closeListener?.(new AppError('CONNECTION_LOST', 'Network connection lost.'))
  }

  // Transfers aren't part of these tests.
  stat(): Promise<RemoteFileStat | null> {
    throw new Error('not used')
  }
  upload(): Promise<void> {
    throw new Error('not used')
  }
  download(): Promise<void> {
    throw new Error('not used')
  }
  rename(): Promise<void> {
    throw new Error('not used')
  }
  mkdir(): Promise<'created' | 'exists'> {
    throw new Error('not used')
  }
  lstat(): Promise<null> {
    throw new Error('not used')
  }
  renameNoReplace(): Promise<void> {
    throw new Error('not used')
  }
  removeDirectory(): Promise<void> {
    throw new Error('not used')
  }
  openShell(): Promise<never> {
    throw new Error('not used')
  }
  remove(): Promise<void> {
    throw new Error('not used')
  }
}

interface FakeServer {
  key: Buffer
  failWith?: unknown
  realpathFails?: boolean
}

describe('ConnectionService', () => {
  let dir: string
  let hostKeys: HostKeyStore
  let server: FakeServer
  let providers: FakeProvider[]
  let closed: ConnectionClosedEvent[]
  let clock: number
  let service: ConnectionService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-connections-'))
    hostKeys = new HostKeyStore(join(dir, 'known-hosts.json'))
    server = { key: KEY_A }
    providers = []
    closed = []
    clock = 1_000_000
    service = new ConnectionService({
      hostKeys,
      createProvider: () => {
        const provider = new FakeProvider(server)
        providers.push(provider)
        return provider
      },
      onConnectionClosed: (event) => closed.push(event),
      pendingTtlMs: 60_000,
      now: () => clock
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise
    } catch (error) {
      return error instanceof AppError ? error.code : String(error)
    }
    return 'did not throw'
  }

  async function connectTrusted(): Promise<string> {
    const first = await service.connect(REQUEST)
    if (first.status !== 'host-key-unknown') throw new Error(`expected a prompt, got ${first.status}`)
    const second = await service.trustHostKeyAndConnect(first.token)
    if (second.status !== 'connected') throw new Error(`expected connected, got ${second.status}`)
    return second.connection.id
  }

  describe('first contact with a host', () => {
    it('refuses the unknown key during the handshake and asks the user', async () => {
      const outcome = await service.connect(REQUEST)

      expect(outcome).toMatchObject({
        status: 'host-key-unknown',
        host: 'example.com',
        port: 22,
        hostKey: { algorithm: 'ssh-ed25519', fingerprint: hostKeyFingerprint(KEY_A) }
      })
      expect(providers[0]?.connected).toBe(false)
      expect(await hostKeys.lookup('example.com', 22)).toBeNull()
    })

    it('never puts the password in what it sends back', async () => {
      expect(JSON.stringify(await service.connect(REQUEST))).not.toContain('hunter2')
    })

    it('stores exactly the key it saw once trusted, then connects requiring it', async () => {
      const id = await connectTrusted()

      expect((await hostKeys.lookup('example.com', 22))?.equals(KEY_A)).toBe(true)
      expect(providers).toHaveLength(2)
      expect(providers[1]?.seenOptions?.auth).toEqual({ type: 'password', password: 'hunter2' })
      expect(providers[1]?.seenOptions?.verifyHostKey(KEY_B)).toBe(false)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('accepts a confirmation token once only', async () => {
      const first = await service.connect(REQUEST)
      if (first.status !== 'host-key-unknown') throw new Error('expected a prompt')
      await service.trustHostKeyAndConnect(first.token)
      expect(await codeOf(service.trustHostKeyAndConnect(first.token))).toBe('INVALID_INPUT')
    })

    it('rejects a confirmation token after it expires, without trusting the key', async () => {
      const first = await service.connect(REQUEST)
      if (first.status !== 'host-key-unknown') throw new Error('expected a prompt')
      clock += 60_001
      expect(await codeOf(service.trustHostKeyAndConnect(first.token))).toBe('INVALID_INPUT')
      expect(await hostKeys.lookup('example.com', 22)).toBeNull()
    })

    it('drops an unanswered question, and the password it holds, when it expires', async () => {
      // The injected clock never moves here, so only the expiry timer can remove it.
      const shortLived = new ConnectionService({
        hostKeys,
        createProvider: () => new FakeProvider(server),
        onConnectionClosed: () => undefined,
        pendingTtlMs: 30,
        now: () => clock
      })
      const first = await shortLived.connect(REQUEST)
      if (first.status !== 'host-key-unknown') throw new Error('expected a prompt')

      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(await codeOf(shortLived.trustHostKeyAndConnect(first.token))).toBe('INVALID_INPUT')
    })

    it('reports a key swapped between the prompt and the retry as changed', async () => {
      const first = await service.connect(REQUEST)
      if (first.status !== 'host-key-unknown') throw new Error('expected a prompt')
      server.key = KEY_B
      const second = await service.trustHostKeyAndConnect(first.token)
      expect(second.status).toBe('host-key-changed')
    })
  })

  describe('a host seen before', () => {
    it('connects without asking when the key matches', async () => {
      await connectTrusted()
      const outcome = await service.connect(REQUEST)
      expect(outcome.status).toBe('connected')
    })

    it('refuses a changed key and shows both fingerprints, keeping the saved key', async () => {
      await connectTrusted()
      server.key = KEY_B

      const outcome = await service.connect(REQUEST)

      expect(outcome).toEqual({
        status: 'host-key-changed',
        host: 'example.com',
        port: 22,
        saved: { algorithm: 'ssh-ed25519', fingerprint: hostKeyFingerprint(KEY_A) },
        offered: { algorithm: 'ssh-ed25519', fingerprint: hostKeyFingerprint(KEY_B) }
      })
      expect((await hostKeys.lookup('example.com', 22))?.equals(KEY_A)).toBe(true)
    })

    it('asks again after the saved key is forgotten', async () => {
      await connectTrusted()
      server.key = KEY_B
      await service.forgetHostKey('example.com', 22)
      expect((await service.connect(REQUEST)).status).toBe('host-key-unknown')
    })

    it('passes through failures that have nothing to do with the host key', async () => {
      await connectTrusted()
      server.failWith = new AppError('AUTH_FAILED', 'Authentication failed.')
      expect(await codeOf(service.connect(REQUEST))).toBe('AUTH_FAILED')
    })
  })

  describe('an open connection', () => {
    it('lists through the provider with the right parent folder', async () => {
      const id = await connectTrusted()
      expect(await service.list(id, '/home/ubuntu')).toEqual({ path: '/home/ubuntu', parentPath: '/home', entries: [] })
      expect((await service.list(id, '/')).parentPath).toBeNull()
    })

    it('rejects requests for an unknown connection', async () => {
      expect(await codeOf(service.list('00000000-0000-4000-8000-000000000000', '/'))).toBe('NOT_CONNECTED')
    })

    it('reports a lost connection once, then forgets it', async () => {
      const id = await connectTrusted()
      providers[1]?.simulateNetworkLoss()
      providers[1]?.simulateNetworkLoss()

      expect(closed).toEqual([{ connectionId: id, code: 'CONNECTION_LOST', message: 'Network connection lost.' }])
      expect(await codeOf(service.list(id, '/'))).toBe('NOT_CONNECTED')
    })

    it('does not report a disconnect the user asked for, and tolerates repeats', async () => {
      const id = await connectTrusted()
      await service.disconnect(id)
      await service.disconnect(id)

      expect(providers[1]?.disconnects).toBe(1)
      expect(closed).toEqual([])
      expect(await codeOf(service.list(id, '/'))).toBe('NOT_CONNECTED')
    })

    it('closes the session if the home folder cannot be resolved', async () => {
      await connectTrusted()
      server.realpathFails = true
      expect(await codeOf(service.connect(REQUEST))).toBe('PERMISSION_DENIED')
      expect(providers.at(-1)?.disconnects).toBe(1)
    })

    it('disconnects everything on shutdown', async () => {
      await connectTrusted()
      await service.connect(REQUEST)
      await service.disconnectAll()
      expect(providers.filter((provider) => provider.connected)).toEqual([])
    })
  })
})
