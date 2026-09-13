import { randomBytes, randomUUID } from 'node:crypto'
import type { AppErrorPayload } from '../../shared/types/errors'
import {
  OUTCOME_LIST_LIMIT,
  type StartTransferOutcome,
  type StartTransferRequest,
  type TransferJob,
  type TransferQueueUpdate,
  type TransferServer,
  type TransferStatus
} from '../../shared/types/transfers'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import { TransferCancelled, type SftpProvider } from '../sftp/sftp-provider'
import { planTransfer, type TransferLimits } from './plan'
import { createProgressReporter } from './progress'
import { removeQuietly, runTransferJob } from './run-job'
import { localSide, remoteSide, type FileSide } from './sides'

const log = createLogger('transfers')

/** Spec section 13: a safe limit, never unlimited. */
export const TRANSFER_CONCURRENCY = 3
export const HISTORY_LIMIT = 1_000

export interface QueueConnections {
  /** Throws NOT_CONNECTED for an unknown or closed connection. */
  providerFor: (connectionId: string) => SftpProvider
  serverOf: (connectionId: string) => TransferServer | null
  /** A live connection to the same server, for retrying after a reconnect. */
  findLive: (server: TransferServer) => string | null
}

/** How long disconnecting or quitting waits for cancelled transfers to clean up. */
export const SETTLE_TIMEOUT_MS = 5_000

export interface TransferQueueOptions {
  connections: QueueConnections
  emit: (update: TransferQueueUpdate) => void
  now?: () => number
  platform?: NodeJS.Platform
  concurrency?: number
  historyLimit?: number
  limits?: TransferLimits
  progressIntervalMs?: number
  randomSuffix?: () => string
  local?: FileSide
  run?: typeof runTransferJob
  settleTimeoutMs?: number
}

interface Entry {
  job: TransferJob
  replace: boolean
  controller: AbortController | null
  /** Resolves when the current run has finished, cleanup included. */
  settled: Promise<void> | null
  /** Temporary files earlier attempts couldn't remove. */
  leftovers: string[]
}

const FINISHED: ReadonlySet<TransferStatus> = new Set(['completed', 'failed', 'cancelled'])
const copy = (job: TransferJob): TransferJob => ({ ...job, server: { ...job.server } })

const internalFailure: AppErrorPayload = { code: 'INTERNAL', message: 'The transfer failed. Please try again.' }

/**
 * The transfer queue (Milestone 7). The main process owns it (spec section 16):
 * requests are planned into one job per file, at most `concurrency` run at
 * once in FIFO order, and every change is pushed to the renderer.
 */
export class TransferQueue {
  private readonly options: TransferQueueOptions
  private readonly now: () => number
  private readonly concurrency: number
  /** Every listed job, in the order it was queued. */
  private readonly entries = new Map<string, Entry>()
  /** Queued ids in FIFO order. May hold ids that were cancelled since; they are skipped. */
  private pending: string[] = []
  private readonly running = new Set<string>()
  private queuedCount = 0
  private finishedCount = 0
  private idleWaiters: Array<() => void> = []

  constructor(options: TransferQueueOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.concurrency = options.concurrency ?? TRANSFER_CONCURRENCY
  }

  async start(request: StartTransferRequest): Promise<StartTransferOutcome> {
    const { connections } = this.options
    const provider = connections.providerFor(request.connectionId)
    const server = connections.serverOf(request.connectionId)
    if (server === null) throw new AppError('NOT_CONNECTED', 'This connection has closed. Connect again to continue.')

    const upload = request.direction === 'upload'
    const local = this.options.local ?? localSide
    const remote = remoteSide(provider)
    const plan = await planTransfer({
      source: upload ? local : remote,
      destination: upload ? remote : local,
      sourcePaths: request.sourcePaths,
      destinationDirectory: request.destinationDirectory,
      onConflict: request.onConflict,
      destinationPlatform: upload ? 'linux' : (this.options.platform ?? process.platform),
      limits: this.options.limits
    })

    if (plan.status === 'conflict') {
      return {
        status: 'conflict',
        conflicts: plan.conflicts.slice(0, OUTCOME_LIST_LIMIT),
        conflictCount: plan.conflicts.length,
        itemCount: request.sourcePaths.length
      }
    }

    const batchId = randomUUID()
    const queuedAt = this.now()
    const added = plan.files.map((file): Entry => ({
      replace: file.replace,
      controller: null,
      settled: null,
      leftovers: [],
      job: {
        id: randomUUID(),
        batchId,
        connectionId: request.connectionId,
        server,
        direction: request.direction,
        name: file.name,
        relativePath: file.relativePath,
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
        destinationDirectory: file.destinationDirectory,
        batchDestination: request.destinationDirectory,
        transferredBytes: 0,
        totalBytes: file.size,
        bytesPerSecond: 0,
        status: 'queued',
        error: null,
        queuedAt,
        startedAt: null,
        finishedAt: null,
        attempt: 1
      }
    }))
    for (const entry of added) {
      this.entries.set(entry.job.id, entry)
      this.pending.push(entry.job.id)
    }
    this.queuedCount += added.length
    if (added.length > 0) this.options.emit({ upserts: added.map((entry) => copy(entry.job)), removals: [] })
    log.info('Transfer queued', {
      batchId,
      direction: request.direction,
      files: added.length,
      folders: plan.folders.length,
      skipped: plan.skipped.length
    })
    this.pump()

    return {
      status: 'queued',
      batchId,
      jobCount: added.length,
      folderCount: plan.folders.length,
      skipped: plan.skipped.slice(0, OUTCOME_LIST_LIMIT),
      skippedCount: plan.skipped.length
    }
  }

  list(): TransferJob[] {
    return [...this.entries.values()].map((entry) => copy(entry.job))
  }

  /** Cancelling an unknown or finished job is not an error. */
  cancel(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    if (entry.job.status === 'queued') {
      this.emitFinished([this.dequeue(entry, 'cancelled', null)])
    } else if (entry.job.status === 'running') {
      entry.controller?.abort()
    }
  }

  /** Resolves once cancelled jobs have cleaned up their temporary files (or after a timeout). */
  cancelAll(): Promise<void> {
    const cancelled: TransferJob[] = []
    const running: Entry[] = []
    for (const entry of this.entries.values()) {
      if (entry.job.status === 'queued') {
        cancelled.push(this.dequeue(entry, 'cancelled', null))
      } else if (entry.job.status === 'running') {
        entry.controller?.abort()
        running.push(entry)
      }
    }
    this.emitFinished(cancelled)
    return this.settle(running)
  }

  /** Queues a failed or cancelled job again, on a live connection to its server. */
  retry(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new AppError('NOT_FOUND', 'This transfer is no longer listed.')
    if (entry.job.status !== 'failed' && entry.job.status !== 'cancelled') return
    if (!this.rebind(entry.job)) throw this.reconnectFirst(entry.job.server)
    this.requeue([entry])
  }

  /** Queues every failed job again; returns how many. Cancelled jobs stay cancelled. */
  retryFailed(): number {
    const failed = [...this.entries.values()].filter((entry) => entry.job.status === 'failed')
    if (failed.length === 0) return 0
    const retryable = failed.filter((entry) => this.rebind(entry.job))
    if (retryable.length === 0) throw this.reconnectFirst((failed[0] as Entry).job.server)
    this.requeue(retryable)
    return retryable.length
  }

  clearFinished(): void {
    const removals: string[] = []
    for (const [id, entry] of this.entries) {
      if (FINISHED.has(entry.job.status)) {
        this.entries.delete(id)
        removals.push(id)
      }
    }
    this.finishedCount = 0
    if (removals.length > 0) this.options.emit({ upserts: [], removals })
  }

  /**
   * The connection is gone. Lost: queued jobs fail with it (running ones fail
   * on their own), so "Retry failed" can bring everything back. Disconnected
   * by the user: its jobs are cancelled.
   */
  connectionClosed(connectionId: string, reason: 'lost' | 'disconnected'): Promise<void> {
    const lost: AppErrorPayload = { code: 'CONNECTION_LOST', message: 'Network connection lost. The server stopped responding.' }
    const finished: TransferJob[] = []
    const running: Entry[] = []
    for (const entry of this.entries.values()) {
      if (entry.job.connectionId !== connectionId) continue
      if (entry.job.status === 'queued') {
        finished.push(reason === 'lost' ? this.dequeue(entry, 'failed', lost) : this.dequeue(entry, 'cancelled', null))
      } else if (entry.job.status === 'running' && reason === 'disconnected') {
        entry.controller?.abort()
        running.push(entry)
      }
    }
    this.emitFinished(finished)
    // Disconnecting waits for cancelled jobs to remove their temporary files while it still can.
    return this.settle(running)
  }

  private settle(entries: Entry[]): Promise<void> {
    const pending = entries.map((entry) => entry.settled).filter((settled): settled is Promise<void> => settled !== null)
    if (pending.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)
      timer.unref?.()
      void Promise.all(pending).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Queued or running jobs, e.g. before quitting. */
  activeCount(): number {
    return this.queuedCount + this.running.size
  }

  /** Resolves when nothing is queued or running (for tests and shutdown). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private isIdle(): boolean {
    return this.running.size === 0 && this.queuedCount === 0
  }

  private checkIdle(): void {
    if (!this.isIdle()) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private rebind(job: TransferJob): boolean {
    try {
      this.options.connections.providerFor(job.connectionId)
      return true
    } catch {
      const live = this.options.connections.findLive(job.server)
      if (live === null) return false
      job.connectionId = live
      return true
    }
  }

  private reconnectFirst(server: TransferServer): AppError {
    return new AppError('NOT_CONNECTED', `Connect to ${server.host} again to retry.`)
  }

  private requeue(entries: Entry[]): void {
    const queuedAt = this.now()
    this.queuedCount += entries.length
    this.finishedCount -= entries.length
    for (const { job } of entries) {
      Object.assign(job, {
        status: 'queued',
        error: null,
        transferredBytes: 0,
        bytesPerSecond: 0,
        startedAt: null,
        finishedAt: null,
        queuedAt,
        attempt: job.attempt + 1
      })
      this.pending.push(job.id)
    }
    this.options.emit({ upserts: entries.map((entry) => copy(entry.job)), removals: [] })
    this.pump()
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift() as string
      const entry = this.entries.get(id)
      if (entry?.job.status !== 'queued') continue
      this.queuedCount -= 1
      entry.settled = this.runEntry(entry)
    }
    this.checkIdle()
  }

  private async runEntry(entry: Entry): Promise<void> {
    const { job } = entry
    const controller = new AbortController()
    entry.controller = controller
    this.running.add(job.id)
    Object.assign(job, { status: 'running', startedAt: this.now(), transferredBytes: 0, bytesPerSecond: 0 })
    this.options.emit({ upserts: [copy(job)], removals: [] })

    const reporter = createProgressReporter({
      now: this.now,
      intervalMs: this.options.progressIntervalMs,
      emit: (snapshot) => {
        if (entry.controller !== controller || job.status !== 'running') return
        Object.assign(job, { transferredBytes: snapshot.transferred, bytesPerSecond: snapshot.bytesPerSecond })
        this.options.emit({ upserts: [copy(job)], removals: [] })
      }
    })

    try {
      const provider = this.options.connections.providerFor(job.connectionId)
      await this.removeLeftovers(entry, provider)
      await (this.options.run ?? runTransferJob)({
        direction: job.direction,
        sourcePath: job.sourcePath,
        destinationPath: job.destinationPath,
        replace: entry.replace,
        provider,
        signal: controller.signal,
        suffix: this.options.randomSuffix?.() ?? randomBytes(6).toString('hex'),
        onStart: (total) => {
          job.totalBytes = total
        },
        onProgress: reporter.update,
        onLeftover: (path) => entry.leftovers.push(path)
      })
      this.finish(entry, 'completed', null, job.totalBytes ?? job.transferredBytes)
    } catch (error) {
      if (controller.signal.aborted || error instanceof TransferCancelled) {
        this.finish(entry, 'cancelled', null)
      } else if (error instanceof AppError) {
        this.finish(entry, 'failed', error.toPayload())
      } else {
        log.error('Transfer failed', { id: job.id, error: error instanceof Error ? error.stack : String(error) })
        this.finish(entry, 'failed', internalFailure)
      }
    } finally {
      entry.controller = null
      this.running.delete(job.id)
      this.pump()
    }
  }

  /** Temporary files a failed attempt left behind (its connection was gone), removed now that one is live. */
  private async removeLeftovers(entry: Entry, provider: SftpProvider): Promise<void> {
    const remaining: string[] = []
    for (const path of entry.leftovers) {
      if (!(await removeQuietly(provider, path, entry.job.direction === 'upload'))) remaining.push(path)
    }
    entry.leftovers = remaining
  }

  /** A running job ended. */
  private finish(entry: Entry, status: TransferStatus, error: AppErrorPayload | null, transferred?: number): void {
    this.markFinished(entry, status, error, transferred)
    log.info('Transfer finished', { id: entry.job.id, status, code: error?.code })
    this.emitFinished([copy(entry.job)])
  }

  /** A queued job that will never run. Its id stays in `pending` and is skipped there. */
  private dequeue(entry: Entry, status: 'cancelled' | 'failed', error: AppErrorPayload | null): TransferJob {
    this.queuedCount -= 1
    this.markFinished(entry, status, error)
    return copy(entry.job)
  }

  private markFinished(entry: Entry, status: TransferStatus, error: AppErrorPayload | null, transferred?: number): void {
    Object.assign(entry.job, {
      status,
      error,
      finishedAt: this.now(),
      bytesPerSecond: 0,
      ...(transferred === undefined ? {} : { transferredBytes: transferred })
    })
    this.finishedCount += 1
  }

  private emitFinished(upserts: TransferJob[]): void {
    const removals = this.trimHistory()
    if (upserts.length > 0 || removals.length > 0) {
      const removed = new Set(removals)
      this.options.emit({ upserts: upserts.filter((job) => !removed.has(job.id)), removals })
    }
    this.checkIdle()
  }

  /** Forgets the oldest finished jobs beyond the history limit. Scans only when over it. */
  private trimHistory(): string[] {
    const excess = this.finishedCount - (this.options.historyLimit ?? HISTORY_LIMIT)
    if (excess <= 0) return []
    const removals: string[] = []
    for (const [id, entry] of this.entries) {
      if (removals.length === excess) break
      if (!FINISHED.has(entry.job.status)) continue
      this.entries.delete(id)
      removals.push(id)
    }
    this.finishedCount -= removals.length
    return removals
  }
}
