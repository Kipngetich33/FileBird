import { beforeEach, describe, expect, it } from 'vitest'
import { MemorySide } from '../../../test/support/memory-side'
import type { TransferJob, TransferQueueUpdate } from '../../shared/types/transfers'
import { AppError } from '../errors'
import { TransferCancelled, type SftpProvider } from '../sftp/sftp-provider'
import { TransferQueue } from './queue'
import type { RunJobOptions } from './run-job'

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const SERVER = { host: 'files.example.org', port: 22, username: 'me' }

/** A job the test finishes by hand. */
interface Pending {
  options: RunJobOptions
  resolve: () => void
  reject: (error: unknown) => void
}

describe('TransferQueue', () => {
  let local: MemorySide
  let remote: MemorySide
  let live: Set<string>
  let updates: TransferQueueUpdate[]
  let runs: Pending[]
  let removed: string[]
  let queue: TransferQueue

  const provider = (): SftpProvider =>
    ({
      stat: (path: string) => remote.stat(path),
      list: (path: string) => remote.list(path),
      mkdir: (path: string) => remote.mkdir(path),
      remove: async (path: string) => {
        removed.push(path)
      }
    }) as unknown as SftpProvider

  const make = (overrides: { historyLimit?: number } = {}): TransferQueue =>
    new TransferQueue({
      connections: {
        providerFor: (id) => {
          if (!live.has(id)) throw new AppError('NOT_CONNECTED', 'closed')
          return provider()
        },
        serverOf: (id) => (live.has(id) ? SERVER : null),
        findLive: () => [...live][0] ?? null
      },
      emit: (update) => updates.push(update),
      local,
      progressIntervalMs: 0,
      run: (options) =>
        new Promise<void>((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new TransferCancelled()))
          runs.push({ options, resolve, reject })
        }),
      ...overrides
    })

  /** The latest state of every job, as the renderer would hold it. */
  const jobs = (): Map<string, TransferJob> => {
    const state = new Map<string, TransferJob>()
    for (const update of updates) {
      for (const job of update.upserts) state.set(job.id, job)
      for (const id of update.removals) state.delete(id)
    }
    return state
  }
  const statuses = (): string[] => [...jobs().values()].map((job) => `${job.name}:${job.status}`)
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const byName = (name: string): TransferJob => {
    const job = [...jobs().values()].find((candidate) => candidate.name === name)
    if (job === undefined) throw new Error(`no job ${name}`)
    return job
  }
  const runFor = (name: string): Pending => {
    const run = runs.find((candidate) => candidate.options.sourcePath.endsWith(`/${name}`))
    if (run === undefined) throw new Error(`${name} is not running`)
    return run
  }

  const uploadFiles = (count: number) =>
    queue.start({
      connectionId: FIRST,
      direction: 'upload',
      sourcePaths: Array.from({ length: count }, (_, i) => `/home/f${i + 1}`),
      destinationDirectory: '/srv',
      onConflict: 'ask'
    })

  beforeEach(() => {
    local = new MemorySide(false, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/home/f${i + 1}`, 10])))
    remote = new MemorySide(true, { '/srv': 'dir' })
    live = new Set([FIRST])
    updates = []
    runs = []
    removed = []
    queue = make()
  })

  it('queues one job per file and runs at most three at once, in order', async () => {
    const outcome = await uploadFiles(5)
    expect(outcome).toMatchObject({ status: 'queued', jobCount: 5, folderCount: 0, skippedCount: 0 })
    expect(runs.map((run) => run.options.sourcePath)).toEqual(['/home/f1', '/home/f2', '/home/f3'])
    expect(statuses()).toEqual(['f1:running', 'f2:running', 'f3:running', 'f4:queued', 'f5:queued'])

    runFor('f2').resolve()
    await settle()
    expect(runs.map((run) => run.options.sourcePath)).toEqual(['/home/f1', '/home/f2', '/home/f3', '/home/f4'])
    expect(byName('f2')).toMatchObject({ status: 'completed', transferredBytes: 10, bytesPerSecond: 0 })
  })

  it('announces a whole request in one update', async () => {
    await uploadFiles(5)
    expect(updates[0]?.upserts.map((job) => job.status)).toEqual(['queued', 'queued', 'queued', 'queued', 'queued'])
  })

  it('cancels a queued job without running it, and a running one by aborting it', async () => {
    await uploadFiles(4)
    queue.cancel(byName('f4').id)
    queue.cancel(byName('f1').id)
    await settle()

    expect(byName('f4').status).toBe('cancelled')
    expect(byName('f1').status).toBe('cancelled')
    expect(runs.some((run) => run.options.sourcePath === '/home/f4')).toBe(false)
  })

  it('reports failures, and retries a failed job as a new attempt', async () => {
    await uploadFiles(1)
    runFor('f1').reject(new AppError('PERMISSION_DENIED', 'No.'))
    await settle()
    expect(byName('f1')).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED' } })

    queue.retry(byName('f1').id)
    expect(byName('f1')).toMatchObject({ status: 'running', attempt: 2, error: null })
    await settle()
    expect(runs).toHaveLength(2)
    runs.at(-1)?.resolve()
    await settle()
    expect(byName('f1').status).toBe('completed')
  })

  it('hides unexpected error details', async () => {
    await uploadFiles(1)
    runFor('f1').reject(new Error('EBADF at 0xdeadbeef'))
    await settle()
    expect(byName('f1').error).toEqual({ code: 'INTERNAL', message: 'The transfer failed. Please try again.' })
  })

  it('fails queued jobs when the connection is lost, and retries them on a new connection to the same server', async () => {
    await uploadFiles(5)
    live.delete(FIRST)
    queue.connectionClosed(FIRST, 'lost')
    expect(statuses().slice(3)).toEqual(['f4:failed', 'f5:failed'])
    expect(byName('f4').error?.code).toBe('CONNECTION_LOST')
    for (const run of runs.splice(0)) run.reject(new AppError('CONNECTION_LOST', 'lost'))
    await settle()

    expect(() => queue.retryFailed()).toThrow('Connect to files.example.org again to retry.')

    live.add(SECOND)
    expect(queue.retryFailed()).toBe(5)
    expect([...jobs().values()].every((job) => job.connectionId === SECOND)).toBe(true)
    expect(statuses()).toEqual(['f1:running', 'f2:running', 'f3:running', 'f4:queued', 'f5:queued'])
  })

  it('cancels every job of a connection the user disconnects, resolving once they have cleaned up', async () => {
    await uploadFiles(4)
    await queue.connectionClosed(FIRST, 'disconnected')
    expect(statuses()).toEqual(['f1:cancelled', 'f2:cancelled', 'f3:cancelled', 'f4:cancelled'])
    await queue.whenIdle()
  })

  it('removes a temporary file a failed attempt left behind before trying again', async () => {
    await uploadFiles(1)
    const first = runFor('f1')
    first.options.onLeftover?.('/srv/.f1.fly-part-abc')
    first.reject(new AppError('CONNECTION_LOST', 'lost'))
    await settle()
    expect(removed).toEqual([])

    queue.retry(byName('f1').id)
    await settle()
    expect(removed).toEqual(['/srv/.f1.fly-part-abc'])
    expect(byName('f1').status).toBe('running')
  })

  it('cancel all, then retry failed leaves cancelled jobs alone', async () => {
    await uploadFiles(4)
    queue.cancelAll()
    await settle()
    expect(statuses().every((status) => status.endsWith(':cancelled'))).toBe(true)
    expect(queue.retryFailed()).toBe(0)
  })

  it('clears finished jobs only', async () => {
    await uploadFiles(4)
    runFor('f1').resolve()
    await settle()
    // f4 started when f1 finished, so cancelling it settles asynchronously.
    queue.cancel(byName('f4').id)
    await settle()
    queue.clearFinished()
    expect(statuses()).toEqual(['f2:running', 'f3:running'])
    expect(queue.list().map((job) => job.name)).toEqual(['f2', 'f3'])
  })

  it('keeps a bounded history of finished jobs', async () => {
    queue = make({ historyLimit: 2 })
    await uploadFiles(5)
    for (const name of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      runFor(name).resolve()
      await settle()
    }
    expect(statuses()).toEqual(['f4:completed', 'f5:completed'])
  })

  it('ignores progress that arrives after a job ended', async () => {
    await uploadFiles(1)
    const run = runFor('f1')
    run.options.onProgress(5, 10)
    queue.cancel(byName('f1').id)
    await settle()
    const count = updates.length
    run.options.onProgress(9, 10)
    expect(updates.length).toBe(count)
    expect(byName('f1').status).toBe('cancelled')
  })

  it('returns conflicts without queueing anything', async () => {
    remote.add('/srv/f1', 3)
    const outcome = await uploadFiles(2)
    expect(outcome).toMatchObject({ status: 'conflict', conflictCount: 1, itemCount: 2, conflicts: [{ name: 'f1' }] })
    expect(updates).toEqual([])
    await queue.whenIdle()
  })

  it('refuses a request on a closed connection', async () => {
    live.clear()
    await expect(uploadFiles(1)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })
})
