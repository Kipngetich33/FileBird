import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import type { ConnectOutcome, ConnectRequest, ConnectionClosedEvent } from '../../shared/types/connection'
import { AppError } from '../errors'
import { HostKeyStore } from '../sftp/host-keys'
import { Ssh2SftpProvider } from '../sftp/ssh2-provider'
import { ConnectionService } from './connection.service'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

function expectStatus<S extends ConnectOutcome['status']>(
  outcome: ConnectOutcome,
  status: S
): Extract<ConnectOutcome, { status: S }> {
  expect(outcome.status).toBe(status)
  return outcome as Extract<ConnectOutcome, { status: S }>
}

describe('ConnectionService against OpenSSH', () => {
  let server: SftpTestServer
  let dir: string
  let service: ConnectionService
  let request: ConnectRequest
  const closed: ConnectionClosedEvent[] = []

  beforeAll(async () => {
    server = await startSftpServer('service')
    await server.buildFixture()
    dir = await mkdtemp(join(tmpdir(), 'fly-service-it-'))
    service = new ConnectionService({
      hostKeys: new HostKeyStore(join(dir, 'known-hosts.json')),
      createProvider: () => new Ssh2SftpProvider({ readyMs: 10_000, keepaliveIntervalMs: 1_000, keepaliveCountMax: 2 }),
      onConnectionClosed: (event) => closed.push(event)
    })
    request = {
      host: server.host,
      port: server.port,
      username: server.username,
      auth: { type: 'password', password: server.password }
    }
  })

  afterAll(async () => {
    await service?.disconnectAll()
    await server?.remove()
    await rm(dir, { recursive: true, force: true })
  })

  it('walks the whole trust-on-first-use cycle against a real server', async () => {
    // 1. Unknown host: refused, and the fingerprint shown is OpenSSH's own.
    const prompt = expectStatus(await service.connect(request), 'host-key-unknown')
    expect(await server.keyscanFingerprints()).toContain(prompt.hostKey.fingerprint)

    // 2. Trusted: connects and lands in the home folder.
    const connected = expectStatus(await service.trustHostKeyAndConnect(prompt.token), 'connected')
    expect(connected.connection).toMatchObject({ host: server.host, port: server.port, username: 'fly', homePath: '/config' })

    const listing = await service.list(connected.connection.id, '/config/fixture')
    expect(listing.parentPath).toBe('/config')
    expect(listing.entries.map((entry) => entry.name)).toContain('alpha')
    await service.disconnect(connected.connection.id)

    // 3. Seen before: no question asked.
    const again = expectStatus(await service.connect(request), 'connected')
    await service.disconnect(again.connection.id)

    // 4. The server now presents different keys: refused, with both fingerprints.
    const before = await server.keyscanFingerprints()
    await server.rotateHostKeys()
    const after = await server.keyscanFingerprints()
    expect(after.some((fingerprint) => before.includes(fingerprint))).toBe(false)

    const changed = expectStatus(await service.connect(request), 'host-key-changed')
    expect(changed.saved.fingerprint).toBe(prompt.hostKey.fingerprint)
    expect(after).toContain(changed.offered.fingerprint)

    // 5. Forgetting the old key brings back the first-contact question.
    await service.forgetHostKey(server.host, server.port)
    const reprompt = expectStatus(await service.connect(request), 'host-key-unknown')
    expect(reprompt.hostKey.fingerprint).toBe(changed.offered.fingerprint)
    expectStatus(await service.trustHostKeyAndConnect(reprompt.token), 'connected')
  })

  it('reports a wrong password without touching the trust store', async () => {
    expect(await codeOf(service.connect({ ...request, auth: { type: 'password', password: 'wrong' } }))).toBe('AUTH_FAILED')
  })

  it('tells the app when the server drops the connection, and rejects later requests', async () => {
    const connected = expectStatus(await service.connect(request), 'connected')
    const id = connected.connection.id

    await server.killSessions()
    const deadline = Date.now() + 5_000
    while (!closed.some((event) => event.connectionId === id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(closed.filter((event) => event.connectionId === id)).toEqual([
      { connectionId: id, code: 'CONNECTION_LOST', message: expect.stringContaining('Network connection lost') }
    ])
    expect(await codeOf(service.list(id, '/config'))).toBe('NOT_CONNECTED')
  })
})
