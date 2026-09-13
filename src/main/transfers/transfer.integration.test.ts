import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import type { StartTransferRequest, TransferUpdate } from '../../shared/types/transfers'
import { AppError } from '../errors'
import { ConnectionService } from '../services/connection.service'
import { HostKeyStore } from '../sftp/host-keys'
import { Ssh2SftpProvider } from '../sftp/ssh2-provider'
import { TransferService } from './transfer.service'

const isRoot = process.getuid?.() === 0
const MB = 1024 * 1024
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

describe('TransferService against OpenSSH', () => {
  let server: SftpTestServer
  let dir: string
  let local: string
  let connections: ConnectionService
  let transfers: TransferService
  let connectionId: string
  const updates: TransferUpdate[] = []

  const lastFor = (id: string): TransferUpdate | undefined => updates.filter((u) => u.id === id).at(-1)
  const remoteSha = async (path: string): Promise<string> => (await server.exec(`sha256sum "${path}"`)).split(' ')[0] ?? ''
  const remoteList = async (path: string): Promise<string[]> => (await server.exec(`ls -A "${path}"`)).split('\n').filter(Boolean)
  const localList = async (path: string): Promise<string[]> => readdir(path)

  /** Starts a transfer and waits for it to end; returns the final update. */
  async function transfer(request: Omit<StartTransferRequest, 'connectionId' | 'onConflict'> & { onConflict?: StartTransferRequest['onConflict'] }): Promise<TransferUpdate> {
    const outcome = await transfers.start({ connectionId, onConflict: 'ask', ...request })
    if (outcome.status !== 'started') throw new Error(`expected started, got ${outcome.status}`)
    await transfers.whenIdle()
    const last = lastFor(outcome.transfer.id)
    if (last === undefined) throw new Error('no updates')
    return last
  }

  async function waitForProgress(id: string): Promise<TransferUpdate> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const running = updates.filter((u) => u.id === id && u.status === 'running' && u.transferredBytes > 0).at(-1)
      if (running !== undefined) return running
      await sleep(10)
    }
    throw new Error('no progress seen')
  }

  beforeAll(async () => {
    server = await startSftpServer('transfers', { tinyDiskBytes: MB })
    await server.exec('mkdir -p /config/drop /config/readonly && chown 1000:1000 /config/drop /config/readonly && chmod 555 /config/readonly')
    dir = await mkdtemp(join(tmpdir(), 'fly-transfers-it-'))
    local = join(dir, 'local')
    await mkdir(local)

    connections = new ConnectionService({
      hostKeys: new HostKeyStore(join(dir, 'known-hosts.json')),
      createProvider: () => new Ssh2SftpProvider({ readyMs: 10_000, keepaliveIntervalMs: 1_000, keepaliveCountMax: 3 }),
      onConnectionClosed: () => undefined
    })
    const request = { host: server.host, port: server.port, username: server.username, auth: { type: 'password' as const, password: server.password } }
    const first = await connections.connect(request)
    const outcome = first.status === 'host-key-unknown' ? await connections.trustHostKeyAndConnect(first.token) : first
    if (outcome.status !== 'connected') throw new Error(`could not connect: ${outcome.status}`)
    connectionId = outcome.connection.id

    transfers = new TransferService({
      providerFor: (id) => connections.providerFor(id),
      emit: (update) => updates.push(update),
      progressIntervalMs: 50
    })
  }, 240_000)

  afterAll(async () => {
    transfers?.cancelAll()
    await transfers?.whenIdle()
    await connections?.disconnectAll()
    await server?.remove()
    if (dir) {
      await chmod(join(dir, 'readonly-local'), 0o755).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uploads a file intact, keeping its permissions and modified time, and leaves no temporary file', async () => {
    const data = randomBytes(8 * MB)
    const path = join(local, 'upload.bin')
    await writeFile(path, data, { mode: 0o640 })
    await chmod(path, 0o640)
    await utimes(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

    const done = await transfer({ direction: 'upload', sourcePath: path, destinationDirectory: '/config/drop' })

    expect(done).toMatchObject({ status: 'completed', transferredBytes: 8 * MB, totalBytes: 8 * MB, destinationPath: '/config/drop/upload.bin' })
    expect(await remoteSha('/config/drop/upload.bin')).toBe(sha(data))
    expect(await server.exec("stat -c '%a %Y' /config/drop/upload.bin")).toBe('640 1700000000')
    expect((await remoteList('/config/drop')).filter((n) => n.includes('fly-part'))).toEqual([])
  })

  it('reports throttled progress that only moves forward and ends at the total', async () => {
    const path = join(local, 'progress.bin')
    await writeFile(path, randomBytes(48 * MB))
    const before = updates.length
    const done = await transfer({ direction: 'upload', sourcePath: path, destinationDirectory: '/config/drop' })
    const mine = updates.slice(before).filter((u) => u.id === done.id)

    const counts = mine.map((u) => u.transferredBytes)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(mine.at(-1)).toMatchObject({ status: 'completed', transferredBytes: 48 * MB })
    const seconds = ((done.finishedAt ?? 0) - done.startedAt) / 1000
    // 50 ms interval: at most ~20 per second, plus the start and the finish.
    expect(mine.length).toBeLessThanOrEqual(Math.ceil(seconds * 20) + 3)
    expect(mine.some((u) => u.status === 'running' && u.bytesPerSecond > 0)).toBe(true)
  })

  it('downloads a file intact and keeps its modified time', async () => {
    await server.exec('head -c 5000000 /dev/urandom > /config/drop/download.bin && chown 1000:1000 /config/drop/download.bin && touch -d @1600000000 /config/drop/download.bin')
    const done = await transfer({ direction: 'download', sourcePath: '/config/drop/download.bin', destinationDirectory: local })

    expect(done.status).toBe('completed')
    const data = await readFile(join(local, 'download.bin'))
    expect(sha(data)).toBe(await remoteSha('/config/drop/download.bin'))
    expect(Math.floor((await stat(join(local, 'download.bin'))).mtimeMs / 1000)).toBe(1_600_000_000)
    expect((await localList(local)).filter((n) => n.includes('fly-part'))).toEqual([])
  })

  it('handles an empty file and a name with spaces and Unicode, both ways', async () => {
    const name = 'spaced ünïcödé 文件.txt'
    await writeFile(join(local, name), '')
    expect((await transfer({ direction: 'upload', sourcePath: join(local, name), destinationDirectory: '/config/drop' })).status).toBe('completed')
    await rm(join(local, name))
    expect((await transfer({ direction: 'download', sourcePath: `/config/drop/${name}`, destinationDirectory: local })).status).toBe('completed')
    expect((await stat(join(local, name))).size).toBe(0)
  })

  describe('when the destination already exists', () => {
    it('asks first, with facts about both files', async () => {
      await writeFile(join(local, 'conflict.txt'), 'new content')
      await server.exec('printf old > /config/drop/conflict.txt && chown 1000:1000 /config/drop/conflict.txt')
      const outcome = await transfers.start({ connectionId, direction: 'upload', sourcePath: join(local, 'conflict.txt'), destinationDirectory: '/config/drop', onConflict: 'ask' })
      expect(outcome).toMatchObject({ status: 'conflict', name: 'conflict.txt', canReplace: true, existing: { size: 3 }, incoming: { size: 11 } })
    })

    it('replaces the existing file when asked', async () => {
      expect((await transfer({ direction: 'upload', sourcePath: join(local, 'conflict.txt'), destinationDirectory: '/config/drop', onConflict: 'replace' })).status).toBe('completed')
      expect(await server.exec('cat /config/drop/conflict.txt')).toBe('new content')
    })

    it('keeps both, numbering the new copy', async () => {
      const done = await transfer({ direction: 'upload', sourcePath: join(local, 'conflict.txt'), destinationDirectory: '/config/drop', onConflict: 'keep-both' })
      expect(done.destinationPath).toBe('/config/drop/conflict (1).txt')
      expect(await server.exec("cat '/config/drop/conflict (1).txt'")).toBe('new content')
    })

    it('never replaces a folder with a file', async () => {
      await server.exec('mkdir -p /config/drop/a-folder && chown 1000:1000 /config/drop/a-folder')
      await writeFile(join(local, 'a-folder'), 'file')
      const outcome = await transfers.start({ connectionId, direction: 'upload', sourcePath: join(local, 'a-folder'), destinationDirectory: '/config/drop', onConflict: 'replace' })
      expect(outcome).toMatchObject({ status: 'conflict', canReplace: false, existing: { isDirectory: true } })
    })
  })

  it('cancels mid-transfer, removes the partial file, and leaves the connection usable', async () => {
    const path = join(local, 'cancel.bin')
    await writeFile(path, randomBytes(256 * MB))
    const outcome = await transfers.start({ connectionId, direction: 'upload', sourcePath: path, destinationDirectory: '/config/drop', onConflict: 'ask' })
    if (outcome.status !== 'started') throw new Error('not started')

    const progress = await waitForProgress(outcome.transfer.id)
    expect(progress.transferredBytes).toBeLessThan(256 * MB)
    transfers.cancel(outcome.transfer.id)
    await transfers.whenIdle()

    expect(lastFor(outcome.transfer.id)).toMatchObject({ status: 'cancelled', error: null })
    const names = await remoteList('/config/drop')
    expect(names.filter((n) => n.includes('cancel.bin'))).toEqual([])
    expect((await connections.list(connectionId, '/config/drop')).entries.length).toBeGreaterThan(0)
    await rm(path)
  })

  it('refuses a second transfer while one is running', async () => {
    const path = join(local, 'busy.bin')
    await writeFile(path, randomBytes(128 * MB))
    const outcome = await transfers.start({ connectionId, direction: 'upload', sourcePath: path, destinationDirectory: '/config/drop', onConflict: 'replace' })
    if (outcome.status !== 'started') throw new Error('not started')
    expect(await codeOf(transfers.start({ connectionId, direction: 'upload', sourcePath: path, destinationDirectory: '/config/drop', onConflict: 'replace' }))).toBe('TRANSFER_BUSY')
    transfers.cancel(outcome.transfer.id)
    await transfers.whenIdle()
    await rm(path)
  })

  describe('failures', () => {
    it('reports a folder without write permission on the server', async () => {
      await writeFile(join(local, 'denied.txt'), 'x')
      const done = await transfer({ direction: 'upload', sourcePath: join(local, 'denied.txt'), destinationDirectory: '/config/readonly' })
      expect(done).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    })

    it('reports a full server disk and removes the partial file', async () => {
      await writeFile(join(local, 'too-big.bin'), randomBytes(4 * MB))
      const done = await transfer({ direction: 'upload', sourcePath: join(local, 'too-big.bin'), destinationDirectory: '/tiny' })
      expect(done).toMatchObject({ status: 'failed', error: { code: 'TRANSFER_FAILED' } })
      expect(done.error?.message).toMatch(/full or read-only/)
      expect(await remoteList('/tiny')).toEqual([])
    })

    it('refuses a missing source or destination folder before starting', async () => {
      expect(await codeOf(transfers.start({ connectionId, direction: 'upload', sourcePath: join(local, 'nope.bin'), destinationDirectory: '/config/drop', onConflict: 'ask' }))).toBe('NOT_FOUND')
      expect(await codeOf(transfers.start({ connectionId, direction: 'download', sourcePath: '/config/drop/nope.bin', destinationDirectory: local, onConflict: 'ask' }))).toBe('NOT_FOUND')
      await writeFile(join(local, 'orphan.txt'), 'x')
      expect(await codeOf(transfers.start({ connectionId, direction: 'upload', sourcePath: join(local, 'orphan.txt'), destinationDirectory: '/config/gone', onConflict: 'ask' }))).toBe('NOT_FOUND')
    })

    it('refuses folders for now', async () => {
      expect(await codeOf(transfers.start({ connectionId, direction: 'download', sourcePath: '/config/drop', destinationDirectory: local, onConflict: 'ask' }))).toBe('INVALID_INPUT')
    })

    it.skipIf(isRoot)('reports a local folder without write permission', async () => {
      await mkdir(join(dir, 'readonly-local'))
      await chmod(join(dir, 'readonly-local'), 0o555)
      const done = await transfer({ direction: 'download', sourcePath: '/config/drop/download.bin', destinationDirectory: join(dir, 'readonly-local') })
      expect(done).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    })

    it('reports a connection dropped mid-download and removes the local partial file', async () => {
      await server.exec('head -c 268435456 /dev/urandom > /config/drop/huge.bin && chown 1000:1000 /config/drop/huge.bin')
      const target = join(dir, 'lost')
      await mkdir(target)
      const outcome = await transfers.start({ connectionId, direction: 'download', sourcePath: '/config/drop/huge.bin', destinationDirectory: target, onConflict: 'ask' })
      if (outcome.status !== 'started') throw new Error('not started')

      await waitForProgress(outcome.transfer.id)
      await server.killSessions()
      await transfers.whenIdle()

      expect(lastFor(outcome.transfer.id)).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_LOST' } })
      expect(await localList(target)).toEqual([])
    })
  })
})
