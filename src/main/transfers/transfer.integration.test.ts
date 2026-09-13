import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import type { StartTransferRequest, TransferJob, TransferQueueUpdate } from '../../shared/types/transfers'
import { AppError } from '../errors'
import { ConnectionService } from '../services/connection.service'
import { HostKeyStore } from '../sftp/host-keys'
import { Ssh2SftpProvider } from '../sftp/ssh2-provider'
import { TransferQueue } from './queue'

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

/** "relative/path sha256" for every file and "relative/" for every folder under a local folder, sorted. */
async function localTree(root: string): Promise<string[]> {
  const lines: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        lines.push(`${relative(root, path)}/`)
        await walk(path)
      } else if (entry.isFile()) {
        lines.push(`${relative(root, path)} ${sha(await readFile(path))}`)
      }
    }
  }
  await walk(root)
  return lines.sort()
}

describe('TransferQueue against OpenSSH', () => {
  let server: SftpTestServer
  let dir: string
  let local: string
  let connections: ConnectionService
  let queue: TransferQueue
  let connectionId: string
  const updates: TransferQueueUpdate[] = []

  /** The latest state of every job, as the renderer would hold it. */
  const jobs = (): Map<string, TransferJob> => {
    const state = new Map<string, TransferJob>()
    for (const update of updates) {
      for (const job of update.upserts) state.set(job.id, job)
      for (const id of update.removals) state.delete(id)
    }
    return state
  }
  const batchJobs = (batchId: string): TransferJob[] => [...jobs().values()].filter((job) => job.batchId === batchId)

  const remoteSha = async (path: string): Promise<string> => (await server.exec(`sha256sum "${path}"`)).split(' ')[0] ?? ''
  const remoteList = async (path: string): Promise<string[]> => (await server.exec(`ls -A "${path}"`)).split('\n').filter(Boolean)
  /** Same format as localTree, computed on the server. Regular files only, like localTree. */
  const remoteTree = async (root: string): Promise<string[]> => {
    const out = await server.exec(
      `cd "${root}" && find . -mindepth 1 -type d | sed 's|^\\./||; s|$|/|' && find . -type f | while IFS= read -r f; do p="\${f#./}"; echo "$p $(sha256sum "$f" | cut -d' ' -f1)"; done`
    )
    return out.split('\n').filter(Boolean).sort()
  }

  async function connect(): Promise<void> {
    const request = { host: server.host, port: server.port, username: server.username, auth: { type: 'password' as const, password: server.password } }
    const first = await connections.connect(request)
    const outcome = first.status === 'host-key-unknown' ? await connections.trustHostKeyAndConnect(first.token) : first
    if (outcome.status !== 'connected') throw new Error(`could not connect: ${outcome.status}`)
    connectionId = outcome.connection.id
  }

  type Request = Omit<StartTransferRequest, 'connectionId' | 'onConflict'> & { onConflict?: StartTransferRequest['onConflict'] }

  /** Queues a request and waits for the queue to be idle; returns the batch's jobs. */
  async function transfer(request: Request): Promise<TransferJob[]> {
    const outcome = await queue.start({ connectionId, onConflict: 'ask', ...request })
    if (outcome.status !== 'queued') throw new Error(`expected queued, got ${outcome.status}`)
    await queue.whenIdle()
    return batchJobs(outcome.batchId)
  }

  async function waitForProgress(id: string): Promise<TransferJob> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const job = jobs().get(id)
      if (job?.status === 'running' && job.transferredBytes > 0) return job
      await sleep(10)
    }
    throw new Error('no progress seen')
  }

  beforeAll(async () => {
    server = await startSftpServer('transfers', { tinyDiskBytes: MB })
    await server.exec(
      'for d in drop readonly trees merge late lost; do mkdir -p /config/$d; done && chown 1000:1000 /config/drop /config/readonly /config/trees /config/merge /config/late /config/lost && chmod 555 /config/readonly'
    )
    dir = await mkdtemp(join(tmpdir(), 'fly-transfers-it-'))
    local = join(dir, 'local')
    await mkdir(local)

    connections = new ConnectionService({
      hostKeys: new HostKeyStore(join(dir, 'known-hosts.json')),
      createProvider: () => new Ssh2SftpProvider({ readyMs: 10_000, keepaliveIntervalMs: 1_000, keepaliveCountMax: 3 }),
      onConnectionClosed: (event) => queue?.connectionClosed(event.connectionId, 'lost')
    })
    await connect()

    queue = new TransferQueue({
      connections: {
        providerFor: (id) => connections.providerFor(id),
        serverOf: (id) => connections.serverOf(id),
        findLive: (target) => connections.findLive(target)
      },
      emit: (update) => updates.push(update),
      progressIntervalMs: 50
    })
  }, 240_000)

  afterAll(async () => {
    queue?.cancelAll()
    await queue?.whenIdle()
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
    await writeFile(path, data)
    await chmod(path, 0o640)
    await utimes(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

    const [job] = await transfer({ direction: 'upload', sourcePaths: [path], destinationDirectory: '/config/drop' })

    expect(job).toMatchObject({ status: 'completed', transferredBytes: 8 * MB, totalBytes: 8 * MB, destinationPath: '/config/drop/upload.bin', relativePath: 'upload.bin' })
    expect(await remoteSha('/config/drop/upload.bin')).toBe(sha(data))
    expect(await server.exec("stat -c '%a %Y' /config/drop/upload.bin")).toBe('640 1700000000')
    expect((await remoteList('/config/drop')).filter((n) => n.includes('fly-part'))).toEqual([])
  })

  it('reports throttled progress that only moves forward and ends at the total', async () => {
    const path = join(local, 'progress.bin')
    await writeFile(path, randomBytes(48 * MB))
    const before = updates.length
    const [done] = await transfer({ direction: 'upload', sourcePaths: [path], destinationDirectory: '/config/drop' })
    if (done === undefined) throw new Error('no job')
    const mine = updates.slice(before).flatMap((update) => update.upserts).filter((job) => job.id === done.id && job.status === 'running')

    const counts = mine.map((job) => job.transferredBytes)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(done).toMatchObject({ status: 'completed', transferredBytes: 48 * MB })
    const seconds = ((done.finishedAt ?? 0) - (done.startedAt ?? 0)) / 1000
    // 50 ms interval: at most ~20 per second, plus the start.
    expect(mine.length).toBeLessThanOrEqual(Math.ceil(seconds * 20) + 3)
    expect(mine.some((job) => job.bytesPerSecond > 0)).toBe(true)
  })

  it('downloads a file intact and keeps its modified time', async () => {
    await server.exec('head -c 5000000 /dev/urandom > /config/drop/download.bin && chown 1000:1000 /config/drop/download.bin && touch -d @1600000000 /config/drop/download.bin')
    const [job] = await transfer({ direction: 'download', sourcePaths: ['/config/drop/download.bin'], destinationDirectory: local })

    expect(job?.status).toBe('completed')
    expect(sha(await readFile(join(local, 'download.bin')))).toBe(await remoteSha('/config/drop/download.bin'))
    expect(Math.floor((await stat(join(local, 'download.bin'))).mtimeMs / 1000)).toBe(1_600_000_000)
    expect((await readdir(local)).filter((n) => n.includes('fly-part'))).toEqual([])
  })

  it('handles an empty file and a name with spaces and Unicode, both ways', async () => {
    const name = 'spaced ünïcödé 文件.txt'
    await writeFile(join(local, name), '')
    expect((await transfer({ direction: 'upload', sourcePaths: [join(local, name)], destinationDirectory: '/config/drop' }))[0]?.status).toBe('completed')
    await rm(join(local, name))
    expect((await transfer({ direction: 'download', sourcePaths: [`/config/drop/${name}`], destinationDirectory: local }))[0]?.status).toBe('completed')
    expect((await stat(join(local, name))).size).toBe(0)
  })

  it('runs several files at once, never more than three, all intact', async () => {
    const paths: string[] = []
    const hashes = new Map<string, string>()
    for (let i = 1; i <= 6; i++) {
      const data = randomBytes(24 * MB)
      const path = join(local, `parallel-${i}.bin`)
      await writeFile(path, data)
      paths.push(path)
      hashes.set(`parallel-${i}.bin`, sha(data))
    }
    const before = updates.length
    const batch = await transfer({ direction: 'upload', sourcePaths: paths, destinationDirectory: '/config/drop' })

    const state = new Map<string, string>()
    let most = 0
    for (const update of updates.slice(before)) {
      for (const job of update.upserts) state.set(job.id, job.status)
      most = Math.max(most, [...state.values()].filter((status) => status === 'running').length)
    }
    expect(batch.map((job) => job.status)).toEqual(Array(6).fill('completed'))
    expect(most).toBe(3)
    for (const [name, hash] of hashes) expect(await remoteSha(`/config/drop/${name}`)).toBe(hash)
  })

  it('uploads a folder tree: nested and empty folders, Unicode, a link to a file; a link to a folder is skipped', async () => {
    const root = join(local, 'project')
    await mkdir(join(root, 'src', 'deep', 'deeper'), { recursive: true })
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'README.md'), 'read me')
    await writeFile(join(root, 'src', 'main.ts'), randomBytes(300_000))
    await writeFile(join(root, 'src', 'deep', 'deeper', 'naïve 文件.txt'), 'unicode')
    await symlink(join(root, 'README.md'), join(root, 'readme-link'))
    await symlink(join(root, 'src'), join(root, 'src-link'))

    const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: [root], destinationDirectory: '/config/trees', onConflict: 'ask' })
    expect(outcome).toMatchObject({ status: 'queued', jobCount: 4, folderCount: 5, skipped: [{ path: 'project/src-link', reason: 'link-to-folder' }] })
    await queue.whenIdle()

    const expected = [...(await localTree(root)), `readme-link ${sha(Buffer.from('read me'))}`].sort()
    expect(await remoteTree('/config/trees/project')).toEqual(expected)
  })

  it('downloads a folder tree the same way', async () => {
    await server.exec(
      [
        'set -e',
        'mkdir -p /config/trees/remote/a/b /config/trees/remote/empty',
        'head -c 200000 /dev/urandom > /config/trees/remote/a/b/data.bin',
        'printf hi > "/config/trees/remote/a/héllo wörld.txt"',
        'ln -s /config/trees/remote/a /config/trees/remote/link-to-a',
        'ln -s /config/trees/remote/missing /config/trees/remote/broken',
        'chown -R -h 1000:1000 /config/trees/remote'
      ].join(' && ')
    )
    const outcome = await queue.start({ connectionId, direction: 'download', sourcePaths: ['/config/trees/remote'], destinationDirectory: local, onConflict: 'ask' })
    expect(outcome).toMatchObject({ status: 'queued', jobCount: 2, folderCount: 4, skippedCount: 2 })
    await queue.whenIdle()

    expect(await localTree(join(local, 'remote'))).toEqual(await remoteTree('/config/trees/remote'))
  })

  describe('when names already exist', () => {
    it('asks first, with facts about both, and touches nothing', async () => {
      await writeFile(join(local, 'conflict.txt'), 'new content')
      await server.exec('printf old > /config/drop/conflict.txt && chown 1000:1000 /config/drop/conflict.txt')
      const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: [join(local, 'conflict.txt')], destinationDirectory: '/config/drop', onConflict: 'ask' })
      expect(outcome).toMatchObject({ status: 'conflict', conflictCount: 1, itemCount: 1, conflicts: [{ name: 'conflict.txt', canReplace: true, existing: { size: 3 }, incoming: { size: 11 } }] })
      expect(await server.exec('cat /config/drop/conflict.txt')).toBe('old')
    })

    it('replaces a file, and keeps both with a numbered name', async () => {
      const source = join(local, 'conflict.txt')
      expect((await transfer({ direction: 'upload', sourcePaths: [source], destinationDirectory: '/config/drop', onConflict: 'replace' }))[0]?.status).toBe('completed')
      expect(await server.exec('cat /config/drop/conflict.txt')).toBe('new content')

      const [copy] = await transfer({ direction: 'upload', sourcePaths: [source], destinationDirectory: '/config/drop', onConflict: 'keep-both' })
      expect(copy?.destinationPath).toBe('/config/drop/conflict (1).txt')
    })

    it('merges a folder on replace: same names replaced, other files kept', async () => {
      await server.exec('mkdir -p /config/merge/site && printf old > /config/merge/site/index.html && printf mine > /config/merge/site/extra.txt && chown -R 1000:1000 /config/merge')
      const site = join(local, 'site')
      await mkdir(site)
      await writeFile(join(site, 'index.html'), 'new')
      await writeFile(join(site, 'about.html'), 'about')

      const batch = await transfer({ direction: 'upload', sourcePaths: [site], destinationDirectory: '/config/merge', onConflict: 'replace' })
      expect(batch.map((job) => job.status)).toEqual(['completed', 'completed'])
      expect(await server.exec('cd /config/merge/site && cat index.html && echo && cat about.html && echo && cat extra.txt')).toBe('new\nabout\nmine')
    })

    it('never replaces a folder with a file', async () => {
      await server.exec('mkdir -p /config/drop/a-folder && chown 1000:1000 /config/drop/a-folder')
      await writeFile(join(local, 'a-folder'), 'file')
      const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: [join(local, 'a-folder')], destinationDirectory: '/config/drop', onConflict: 'replace' })
      expect(outcome).toMatchObject({ status: 'queued', jobCount: 0, skipped: [{ path: 'a-folder', reason: 'kind-mismatch' }] })
      await rm(join(local, 'a-folder'))
    })

    it('fails a job whose destination appeared after it was queued', async () => {
      const big = await Promise.all(
        [1, 2, 3].map(async (i) => {
          const path = join(local, `slot-${i}.bin`)
          await writeFile(path, Buffer.alloc(256 * MB))
          return path
        })
      )
      await writeFile(join(local, 'late.txt'), 'late')
      const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: [...big, join(local, 'late.txt')], destinationDirectory: '/config/late', onConflict: 'ask' })
      if (outcome.status !== 'queued') throw new Error('not queued')
      const late = batchJobs(outcome.batchId).find((job) => job.name === 'late.txt')
      expect(late?.status).toBe('queued')

      await server.exec('printf theirs > /config/late/late.txt && chown 1000:1000 /config/late/late.txt')
      for (const job of batchJobs(outcome.batchId)) if (job.name !== 'late.txt') queue.cancel(job.id)
      await queue.whenIdle()

      expect(jobs().get(late?.id ?? '')).toMatchObject({ status: 'failed', error: { code: 'ALREADY_EXISTS' } })
      expect(await server.exec('cat /config/late/late.txt')).toBe('theirs')
      await Promise.all(big.map((path) => rm(path)))
    })
  })

  it('cancels a queued job without writing it, and running ones leaving no partial file', async () => {
    const paths = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const path = join(local, `cancel-${i}.bin`)
        await writeFile(path, Buffer.alloc(256 * MB))
        return path
      })
    )
    const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: paths, destinationDirectory: '/config/drop', onConflict: 'ask' })
    if (outcome.status !== 'queued') throw new Error('not queued')
    const [first, , , fourth] = batchJobs(outcome.batchId)
    if (first === undefined || fourth === undefined) throw new Error('missing jobs')
    expect(fourth.status).toBe('queued')

    await waitForProgress(first.id)
    queue.cancel(fourth.id)
    queue.cancelAll()
    await queue.whenIdle()

    expect(batchJobs(outcome.batchId).map((job) => job.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
    expect((await remoteList('/config/drop')).filter((name) => name.includes('cancel-'))).toEqual([])
    expect((await connections.list(connectionId, '/config/drop')).entries.length).toBeGreaterThan(0)
    await Promise.all(paths.map((path) => rm(path)))
  })

  it('waits for cancelled uploads to remove their partial files before a disconnect', async () => {
    const path = join(local, 'disconnect.bin')
    await writeFile(path, Buffer.alloc(256 * MB))
    await server.exec('mkdir -p /config/disconnect && chown 1000:1000 /config/disconnect')
    const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: [path], destinationDirectory: '/config/disconnect', onConflict: 'ask' })
    if (outcome.status !== 'queued') throw new Error('not queued')
    const [job] = batchJobs(outcome.batchId)
    await waitForProgress(job?.id ?? '')

    await queue.connectionClosed(connectionId, 'disconnected')
    await connections.disconnect(connectionId)

    expect(jobs().get(job?.id ?? '')?.status).toBe('cancelled')
    expect(await remoteList('/config/disconnect')).toEqual([])
    await connect()
    await rm(path)
  })

  describe('failures', () => {
    it('reports a folder without write permission on the server', async () => {
      await writeFile(join(local, 'denied.txt'), 'x')
      const [job] = await transfer({ direction: 'upload', sourcePaths: [join(local, 'denied.txt')], destinationDirectory: '/config/readonly' })
      expect(job).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    })

    it('reports a full server disk and removes the partial file', async () => {
      await writeFile(join(local, 'too-big.bin'), randomBytes(4 * MB))
      const [job] = await transfer({ direction: 'upload', sourcePaths: [join(local, 'too-big.bin')], destinationDirectory: '/tiny' })
      expect(job).toMatchObject({ status: 'failed', error: { code: 'TRANSFER_FAILED' } })
      expect(job?.error?.message).toMatch(/full or read-only/)
      expect(await remoteList('/tiny')).toEqual([])
    })

    it('refuses a missing source or destination folder before queueing', async () => {
      expect(await codeOf(queue.start({ connectionId, direction: 'upload', sourcePaths: [join(local, 'nope.bin')], destinationDirectory: '/config/drop', onConflict: 'ask' }))).toBe('NOT_FOUND')
      expect(await codeOf(queue.start({ connectionId, direction: 'download', sourcePaths: ['/config/drop/nope.bin'], destinationDirectory: local, onConflict: 'ask' }))).toBe('NOT_FOUND')
      await writeFile(join(local, 'orphan.txt'), 'x')
      expect(await codeOf(queue.start({ connectionId, direction: 'upload', sourcePaths: [join(local, 'orphan.txt')], destinationDirectory: '/config/gone', onConflict: 'ask' }))).toBe('NOT_FOUND')
    })

    it.skipIf(isRoot)('reports a local folder without write permission', async () => {
      await mkdir(join(dir, 'readonly-local'))
      await chmod(join(dir, 'readonly-local'), 0o555)
      const [job] = await transfer({ direction: 'download', sourcePaths: ['/config/drop/download.bin'], destinationDirectory: join(dir, 'readonly-local') })
      expect(job).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })
    })

    it('reports a connection dropped mid-download and removes the local partial file', async () => {
      await server.exec('head -c 268435456 /dev/urandom > /config/drop/huge.bin && chown 1000:1000 /config/drop/huge.bin')
      const target = join(dir, 'lost')
      await mkdir(target)
      const outcome = await queue.start({ connectionId, direction: 'download', sourcePaths: ['/config/drop/huge.bin'], destinationDirectory: target, onConflict: 'ask' })
      if (outcome.status !== 'queued') throw new Error('not queued')
      const [job] = batchJobs(outcome.batchId)

      await waitForProgress(job?.id ?? '')
      await server.killSessions()
      await queue.whenIdle()

      expect(jobs().get(job?.id ?? '')).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_LOST' } })
      expect(await readdir(target)).toEqual([])
      await connect()
    })

    it('fails running and queued jobs when the connection drops, and retries them all on a new connection', async () => {
      // "Retry failed" retries every failed job; start from an empty history.
      queue.clearFinished()
      const hashes = new Map<string, string>()
      const paths = await Promise.all(
        [1, 2, 3, 4, 5].map(async (i) => {
          const data = randomBytes(64 * MB)
          const path = join(local, `retry-${i}.bin`)
          await writeFile(path, data)
          hashes.set(`retry-${i}.bin`, sha(data))
          return path
        })
      )
      const outcome = await queue.start({ connectionId, direction: 'upload', sourcePaths: paths, destinationDirectory: '/config/lost', onConflict: 'ask' })
      if (outcome.status !== 'queued') throw new Error('not queued')
      const [first] = batchJobs(outcome.batchId)
      await waitForProgress(first?.id ?? '')

      const oldConnection = connectionId
      await server.killSessions()
      await queue.whenIdle()
      expect(batchJobs(outcome.batchId).map((job) => job.error?.code)).toEqual(Array(5).fill('CONNECTION_LOST'))
      expect(() => queue.retryFailed()).toThrow(/Connect to 127\.0\.0\.1 again/)

      await connect()
      expect(connectionId).not.toBe(oldConnection)
      expect(queue.retryFailed()).toBe(5)
      await queue.whenIdle()

      const retried = batchJobs(outcome.batchId)
      expect(retried.map((job) => [job.status, job.attempt, job.connectionId])).toEqual(Array(5).fill(['completed', 2, connectionId]))
      for (const [name, hash] of hashes) expect(await remoteSha(`/config/lost/${name}`)).toBe(hash)
      // The partial files the dropped connection couldn't remove were removed on retry.
      expect((await remoteList('/config/lost')).filter((name) => name.includes('fly-part'))).toEqual([])
    })
  })
})
