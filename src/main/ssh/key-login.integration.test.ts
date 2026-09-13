import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import { generateTestKeys, type TestKeyName, type TestKeySet } from '../../../test/support/ssh-keys'
import type { ConnectOutcome, ConnectRequest } from '../../shared/types/connection'
import { AppError } from '../errors'
import { ConnectionService } from '../services/connection.service'
import { HostKeyStore } from '../sftp/host-keys'
import { Ssh2SftpProvider } from '../sftp/ssh2-provider'

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, message: error.message }
    return { code: 'not an AppError', message: String(error) }
  }
  return { code: 'did not throw', message: '' }
}

async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return address.port
}

describe('private key login against a key-only OpenSSH server', () => {
  let server: SftpTestServer
  let keys: TestKeySet
  let dir: string
  let service: ConnectionService

  const request = (name: TestKeyName, passphrase?: string, port = server.port): ConnectRequest => ({
    host: server.host,
    port,
    username: server.username,
    auth: { type: 'privateKey', privateKeyPath: keys.keys[name].path, passphrase }
  })

  /** Connects, trusting the host key on first contact, and returns the final outcome. */
  async function connect(req: ConnectRequest): Promise<ConnectOutcome> {
    const first = await service.connect(req)
    return first.status === 'host-key-unknown' ? service.trustHostKeyAndConnect(first.token) : first
  }

  beforeAll(async () => {
    ;[server, keys] = await Promise.all([startSftpServer('keys', { passwordAccess: false }), generateTestKeys()])
    for (const name of ['ed25519', 'rsa', 'ecdsa', 'ed25519-encrypted', 'rsa-pem-encrypted'] as const) {
      await server.authorizeKey(keys.keys[name].publicKey)
    }
    dir = await mkdtemp(join(tmpdir(), 'fly-key-login-'))
    service = new ConnectionService({
      hostKeys: new HostKeyStore(join(dir, 'known-hosts.json')),
      createProvider: () => new Ssh2SftpProvider({ readyMs: 10_000 }),
      onConnectionClosed: () => undefined
    })
  })

  afterAll(async () => {
    await service?.disconnectAll()
    await server?.remove()
    await keys?.remove()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it.each([
    ['ed25519', undefined],
    ['rsa', undefined],
    ['ecdsa', undefined],
    ['ed25519-encrypted', 'passphrase'],
    ['rsa-pem-encrypted', 'passphrase']
  ] as const)('logs in with a %s key', async (name, needsPassphrase) => {
    const outcome = await connect(request(name, needsPassphrase ? keys.keys[name].passphrase : undefined))
    expect(outcome.status).toBe('connected')
    if (outcome.status === 'connected') {
      expect(outcome.connection.homePath).toBe('/config')
      await service.disconnect(outcome.connection.id)
    }
  })

  it('reports a valid key the server does not know as AUTH_FAILED, naming the key', async () => {
    const result = await failure(connect(request('unauthorised')))
    expect(result.code).toBe('AUTH_FAILED')
    expect(result.message).toMatch(/didn't accept this key/)
  })

  it('refuses a password on a key-only server', async () => {
    const result = await failure(
      connect({ host: server.host, port: server.port, username: 'fly', auth: { type: 'password', password: server.password } })
    )
    expect(result.code).toBe('AUTH_FAILED')
  })

  it('checks the passphrase before any network use: nothing is listening, yet the key error wins', async () => {
    const nowhere = await closedPort()
    expect((await failure(service.connect(request('ed25519-encrypted', 'wrong', nowhere)))).code).toBe('KEY_PASSPHRASE_INCORRECT')
    expect((await failure(service.connect(request('ed25519-encrypted', undefined, nowhere)))).code).toBe('KEY_PASSPHRASE_REQUIRED')
    // And with a good passphrase the same port fails for the network reason instead.
    const good = request('ed25519-encrypted', keys.keys['ed25519-encrypted'].passphrase, nowhere)
    expect((await failure(service.connect(good))).code).toBe('CONNECTION_REFUSED')
  })

  it('refuses unsupported and public key files before connecting', async () => {
    expect((await failure(service.connect(request('rsa-pkcs8')))).code).toBe('KEY_INVALID')
    const pub = { ...request('ed25519'), auth: { type: 'privateKey' as const, privateKeyPath: `${keys.keys.ed25519.path}.pub` } }
    expect((await failure(service.connect(pub))).code).toBe('KEY_IS_PUBLIC')
  })
})
