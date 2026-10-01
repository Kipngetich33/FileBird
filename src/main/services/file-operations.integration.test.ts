import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import { AppError } from '../errors'
import { HostKeyStore } from '../sftp/host-keys'
import { Ssh2SftpProvider } from '../sftp/ssh2-provider'
import { ConnectionService } from './connection.service'
import { FileOperationsService } from './file-operations.service'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

describe('FileOperationsService against OpenSSH', () => {
  let server: SftpTestServer
  let dir: string
  let connections: ConnectionService
  let operations: FileOperationsService
  let remote: { side: 'remote'; connectionId: string }

  const ls = async (path: string): Promise<string[]> => (await server.exec(`ls -A "${path}"`)).split('\n').filter(Boolean)

  beforeAll(async () => {
    server = await startSftpServer('file-ops')
    dir = await mkdtemp(join(tmpdir(), 'fly-file-ops-it-'))
    connections = new ConnectionService({
      hostKeys: new HostKeyStore(join(dir, 'known-hosts.json')),
      createProvider: () => new Ssh2SftpProvider(),
      onConnectionClosed: () => undefined
    })
    const request = { host: server.host, port: server.port, username: server.username, auth: { type: 'password' as const, password: server.password } }
    const first = await connections.connect(request)
    const outcome = first.status === 'host-key-unknown' ? await connections.trustHostKeyAndConnect(first.token) : first
    if (outcome.status !== 'connected') throw new Error('not connected')
    remote = { side: 'remote', connectionId: outcome.connection.id }
    operations = new FileOperationsService({
      localHome: dir,
      platform: process.platform,
      trash: async () => undefined,
      providerFor: (id) => connections.providerFor(id),
      remoteHomeOf: (id) => connections.homeOf(id)
    })
    await server.exec('mkdir -p /config/work && chown 1000:1000 /config/work')
  }, 240_000)

  afterAll(async () => {
    await connections?.disconnectAll()
    await server?.remove()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('creates a folder, and refuses a taken name or a missing parent', async () => {
    expect(await operations.createFolder(remote, '/config/work', 'new folder')).toBe('/config/work/new folder')
    expect(await server.exec("stat -c '%F' '/config/work/new folder'")).toBe('directory')
    expect(await codeOf(operations.createFolder(remote, '/config/work', 'new folder'))).toBe('ALREADY_EXISTS')
    expect(await codeOf(operations.createFolder(remote, '/config/nowhere', 'x'))).toBe('NOT_FOUND')
  })

  it('renames a file and a folder, and never replaces an existing name', async () => {
    await server.exec('cd /config/work && printf a > a.txt && printf b > b.txt && mkdir -p dir && chown -R 1000:1000 .')
    expect(await operations.rename(remote, '/config/work/a.txt', 'c.txt')).toBe('/config/work/c.txt')
    expect(await operations.rename(remote, '/config/work/dir', 'renamed dir')).toBe('/config/work/renamed dir')
    expect(await codeOf(operations.rename(remote, '/config/work/c.txt', 'b.txt'))).toBe('ALREADY_EXISTS')
    expect(await server.exec('cat /config/work/b.txt /config/work/c.txt')).toBe('ba')
  })

  it('deletes a tree, removing a link to an outside folder without following it', async () => {
    await server.exec(
      [
        'set -e',
        'mkdir -p /config/outside /config/work/tree/a/b/c /config/work/tree/empty',
        'printf keep > /config/outside/precious.txt',
        'printf x > /config/work/tree/a/one.txt',
        'printf y > /config/work/tree/a/b/c/two.txt',
        'ln -s /config/outside /config/work/tree/a/link-to-outside',
        'ln -s /config/missing /config/work/tree/broken',
        'printf z > /config/work/single.txt',
        'chown -R -h 1000:1000 /config/work /config/outside'
      ].join(' && ')
    )
    const outcome = await operations.delete(remote, ['/config/work/tree', '/config/work/single.txt'])

    expect(outcome).toEqual({ deleted: 2, failures: [] })
    expect(await ls('/config/work')).not.toContain('tree')
    expect(await ls('/config/work')).not.toContain('single.txt')
    expect(await server.exec('cat /config/outside/precious.txt')).toBe('keep')
  })

  it('deletes a link to a folder that was selected itself, leaving the target', async () => {
    await server.exec('ln -s /config/outside /config/work/selected-link && chown -h 1000:1000 /config/work/selected-link')
    expect(await operations.delete(remote, ['/config/work/selected-link'])).toEqual({ deleted: 1, failures: [] })
    expect(await ls('/config/outside')).toEqual(['precious.txt'])
  })

  it('reports what it could not delete and carries on with the rest', async () => {
    await server.exec(
      'mkdir -p /config/work/stuck/locked && printf l > /config/work/stuck/locked/file && printf f > /config/work/free.txt && chown -R 1000:1000 /config/work && chmod 555 /config/work/stuck/locked'
    )
    const outcome = await operations.delete(remote, ['/config/work/stuck', '/config/work/free.txt', '/config/work/never-was'])

    expect(outcome.deleted).toBe(1)
    expect(outcome.failures.map((failure) => [failure.name, failure.error.code])).toEqual([
      ['stuck', 'PERMISSION_DENIED'],
      ['never-was', 'NOT_FOUND']
    ])
    expect(await ls('/config/work')).not.toContain('free.txt')
    expect(await server.exec('cat /config/work/stuck/locked/file')).toBe('l')
    await server.exec('chmod 755 /config/work/stuck/locked')
  })

  it('moves items into a folder on the server, without copying or overwriting', async () => {
    await server.exec('mkdir -p /config/moving/inbox && printf one > /config/moving/a.txt && printf two > /config/moving/b.txt')
    await server.exec('printf taken > /config/moving/inbox/b.txt && chown -R 1000:1000 /config/moving')

    const outcome = await operations.move(remote, ['/config/moving/a.txt', '/config/moving/b.txt'], '/config/moving/inbox')
    expect(outcome.moved).toBe(1)
    expect(outcome.alreadyThere).toBe(0)
    expect(outcome.failures.map((failure) => [failure.name, failure.error.code])).toEqual([['b.txt', 'ALREADY_EXISTS']])

    // The one that moved is there once; the one that clashed left both files untouched.
    expect((await ls('/config/moving/inbox')).sort()).toEqual(['a.txt', 'b.txt'])
    expect(await ls('/config/moving')).toEqual(['b.txt', 'inbox'])
    expect(await server.exec('cat /config/moving/inbox/b.txt')).toBe('taken')
    expect(await server.exec('cat /config/moving/b.txt')).toBe('two')
    expect(await server.exec('cat /config/moving/inbox/a.txt')).toBe('one')
  })

  it('moves a whole folder, and refuses to move one inside itself', async () => {
    await server.exec('mkdir -p /config/tree/branch/leaf && printf x > /config/tree/branch/leaf/deep.txt && chown -R 1000:1000 /config/tree')

    expect((await operations.move(remote, ['/config/tree/branch'], '/config/tree/branch/leaf')).failures[0]?.error.code).toBe('NOT_ALLOWED')
    expect(await ls('/config/tree')).toEqual(['branch'])

    await server.exec('mkdir -p /config/tree/elsewhere && chown 1000:1000 /config/tree/elsewhere')
    expect((await operations.move(remote, ['/config/tree/branch'], '/config/tree/elsewhere')).moved).toBe(1)
    expect(await ls('/config/tree/elsewhere/branch/leaf')).toEqual(['deep.txt'])
  })

  it('refuses to move the home folder, and refuses a destination that is not a folder', async () => {
    await server.exec('printf file > /config/not-a-folder.txt && chown 1000:1000 /config/not-a-folder.txt')
    expect(await codeOf(operations.move(remote, ['/config'], '/config/moving'))).toBe('NOT_ALLOWED')
    expect(await codeOf(operations.move(remote, ['/config/moving'], '/config/not-a-folder.txt'))).toBe('NOT_A_DIRECTORY')
  })

  it('refuses the home folder, its ancestors and the root, before deleting anything', async () => {
    await server.exec('printf s > /config/work/survivor.txt && chown 1000:1000 /config/work/survivor.txt')
    expect(await codeOf(operations.delete(remote, ['/config/work/survivor.txt', '/config']))).toBe('NOT_ALLOWED')
    expect(await codeOf(operations.delete(remote, ['/']))).toBe('NOT_ALLOWED')
    expect(await codeOf(operations.rename(remote, '/config', 'moved'))).toBe('NOT_ALLOWED')
    expect(await ls('/config/work')).toContain('survivor.txt')
  })
})
