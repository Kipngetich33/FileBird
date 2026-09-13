import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectOutcome, ConnectRequest } from '../../shared/types/connection'
import type { ConnectionInput } from '../../shared/types/connections'
import { AppError } from '../errors'
import { type SecretStore, secretAccount } from '../secrets/secret-store'
import { ConnectionStorage } from '../storage/connection-storage'
import type { ConnectHooks } from './connection.service'
import { ConnectionProfilesService, type Connector } from './connection-profiles.service'

class MemorySecrets implements SecretStore {
  readonly items = new Map<string, string>()
  failWrites = false
  async get(account: string): Promise<string | null> {
    return this.items.get(account) ?? null
  }
  async set(account: string, secret: string): Promise<void> {
    if (this.failWrites) throw new AppError('KEYCHAIN_UNAVAILABLE', 'no keychain')
    this.items.set(account, secret)
  }
  async delete(account: string): Promise<void> {
    this.items.delete(account)
  }
}

/** Accepts exactly one password / passphrase, like a server and a key file would. */
class FakeConnector implements Connector {
  readonly requests: ConnectRequest[] = []
  acceptedPassword = 'right-password'
  acceptedPassphrase = 'right-passphrase'
  keyEncrypted = true
  /** Simulates the first-contact prompt: the hooks are not run yet. */
  promptHostKey = false
  lastHooks: ConnectHooks | undefined

  async connect(request: ConnectRequest, hooks?: ConnectHooks): Promise<ConnectOutcome> {
    this.requests.push(request)
    this.lastHooks = hooks
    if (request.auth.type === 'privateKey' && this.keyEncrypted) {
      if (request.auth.passphrase === undefined) throw new AppError('KEY_PASSPHRASE_REQUIRED', 'needs passphrase')
      if (request.auth.passphrase !== this.acceptedPassphrase) throw new AppError('KEY_PASSPHRASE_INCORRECT', 'bad')
    }
    if (request.auth.type === 'password' && request.auth.password !== this.acceptedPassword) {
      throw new AppError('AUTH_FAILED', 'Authentication failed.')
    }
    if (this.promptHostKey) {
      return { status: 'host-key-unknown', token: 'token', host: request.host, port: request.port, hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x' } }
    }
    const connection = { id: 'conn-1', host: request.host, port: request.port, username: request.username, homePath: '/home/u' }
    const notice = await hooks?.onConnected?.(connection)
    return notice === undefined ? { status: 'connected', connection } : { status: 'connected', connection, notice }
  }
}

const PASSWORD_INPUT: ConnectionInput = { name: 'Web', host: 'web.example.com', port: 22, username: 'deploy', auth: { type: 'password' } }
const KEY_INPUT: ConnectionInput = {
  name: 'Api',
  host: 'api.example.com',
  port: 2200,
  username: 'ubuntu',
  auth: { type: 'privateKey', privateKeyPath: '/keys/id_ed25519' }
}

describe('ConnectionProfilesService', () => {
  let dir: string
  let storage: ConnectionStorage
  let secrets: MemorySecrets
  let connector: FakeConnector
  let service: ConnectionProfilesService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-profiles-'))
    storage = new ConnectionStorage(join(dir, 'connections.json'))
    secrets = new MemorySecrets()
    connector = new FakeConnector()
    service = new ConnectionProfilesService({ storage, secrets, connections: connector, now: () => new Date('2026-09-13T12:00:00Z') })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const status = (outcome: ConnectOutcome): string =>
    outcome.status === 'secret-required' ? `secret-required:${outcome.kind}:${outcome.reason}` : outcome.status

  describe('password profiles', () => {
    it('asks for the password when none is saved, without trying to connect', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      expect(status(await service.connect(id))).toBe('secret-required:password:not-saved')
      expect(connector.requests).toEqual([])
    })

    it('remembers a password only after the server accepted it', async () => {
      const { id } = await service.create(PASSWORD_INPUT)

      expect(status(await service.connect(id, { value: 'typo', remember: true }))).toBe('secret-required:password:rejected')
      expect(secrets.items.size).toBe(0)

      expect(status(await service.connect(id, { value: 'right-password', remember: true }))).toBe('connected')
      expect(secrets.items.get(secretAccount(id, 'password'))).toBe('right-password')
      expect((await service.list())[0]?.savedSecret).toBe('password')
    })

    it('uses the saved password next time, and asks again if the server stops accepting it', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      await service.connect(id, { value: 'right-password', remember: true })

      expect(status(await service.connect(id))).toBe('connected')
      expect(connector.requests.at(-1)?.auth).toEqual({ type: 'password', password: 'right-password' })

      connector.acceptedPassword = 'rotated'
      expect(status(await service.connect(id))).toBe('secret-required:password:rejected')
    })

    it('forgets a saved password when the user connects with "remember" unticked', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      await service.connect(id, { value: 'right-password', remember: true })
      await service.connect(id, { value: 'right-password', remember: false })
      expect(secrets.items.size).toBe(0)
    })

    it('saves after a host key is trusted, not before', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      connector.promptHostKey = true
      expect(status(await service.connect(id, { value: 'right-password', remember: true }))).toBe('host-key-unknown')
      expect(secrets.items.size).toBe(0)

      // The trust step later runs the same hooks once the connection is ready.
      await connector.lastHooks?.onConnected?.({ id: 'c', host: 'h', port: 22, username: 'u', homePath: '/' })
      expect(secrets.items.get(secretAccount(id, 'password'))).toBe('right-password')
    })

    it('still connects when the keychain refuses the save, and says so', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      secrets.failWrites = true
      const outcome = await service.connect(id, { value: 'right-password', remember: true })
      expect(outcome).toMatchObject({ status: 'connected', notice: expect.stringContaining("couldn't save the password") })
    })
  })

  describe('key profiles', () => {
    it('asks for a passphrase only when the key needs one', async () => {
      const { id } = await service.create(KEY_INPUT)
      expect(status(await service.connect(id))).toBe('secret-required:passphrase:not-saved')

      connector.keyEncrypted = false
      expect(status(await service.connect(id))).toBe('connected')
      expect(connector.requests.at(-1)?.auth).toEqual({ type: 'privateKey', privateKeyPath: '/keys/id_ed25519', passphrase: undefined })
    })

    it('reports a wrong passphrase and remembers the right one after login', async () => {
      const { id } = await service.create(KEY_INPUT)
      expect(status(await service.connect(id, { value: 'wrong', remember: true }))).toBe('secret-required:passphrase:rejected')
      expect(status(await service.connect(id, { value: 'right-passphrase', remember: true }))).toBe('connected')
      expect(secrets.items.get(secretAccount(id, 'passphrase'))).toBe('right-passphrase')
      expect(status(await service.connect(id))).toBe('connected')
    })

    it('passes a server rejection of the key straight through', async () => {
      const { id } = await service.create(KEY_INPUT)
      connector.keyEncrypted = false
      connector.connect = async () => {
        throw new AppError('AUTH_FAILED', "The server didn't accept this key.")
      }
      await expect(service.connect(id)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    })
  })

  describe('editing and deleting', () => {
    it('drops a saved secret that no longer applies after an edit', async () => {
      const { id } = await service.create(KEY_INPUT)
      await service.connect(id, { value: 'right-passphrase', remember: true })

      await service.update(id, { ...KEY_INPUT, name: 'Renamed' })
      expect(secrets.items.has(secretAccount(id, 'passphrase'))).toBe(true)

      await service.update(id, { ...KEY_INPUT, auth: { type: 'privateKey', privateKeyPath: '/keys/other' } })
      expect(secrets.items.has(secretAccount(id, 'passphrase'))).toBe(false)
    })

    it('drops the password when switching to key login', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      await service.connect(id, { value: 'right-password', remember: true })
      await service.update(id, KEY_INPUT)
      expect(secrets.items.size).toBe(0)
    })

    it('deletes a connection together with its secrets', async () => {
      const { id } = await service.create(PASSWORD_INPUT)
      await service.connect(id, { value: 'right-password', remember: true })
      await service.delete(id)
      expect(await service.list()).toEqual([])
      expect(secrets.items.size).toBe(0)
      await expect(service.connect(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('lists alphabetically, naturally, and never exposes a secret', async () => {
      for (const name of ['server10', 'Server2', 'alpha']) await service.create({ ...PASSWORD_INPUT, name })
      const [first] = await service.list()
      await service.connect(first?.id ?? '', { value: 'right-password', remember: true })

      const listed = await service.list()
      expect(listed.map((p) => p.name)).toEqual(['alpha', 'Server2', 'server10'])
      expect(JSON.stringify(listed)).not.toContain('right-password')
      expect(await readFile(join(dir, 'connections.json'), 'utf8')).not.toContain('right-password')
    })
  })

  describe('connecting without saving', () => {
    it('never stores the profile or the secret', async () => {
      expect(status(await service.connectUnsaved(PASSWORD_INPUT))).toBe('secret-required:password:not-saved')
      expect(status(await service.connectUnsaved(PASSWORD_INPUT, { value: 'right-password', remember: true }))).toBe('connected')
      expect(await service.list()).toEqual([])
      expect(secrets.items.size).toBe(0)
    })
  })
})
