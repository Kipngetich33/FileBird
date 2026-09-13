import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { ConflictResolution, StartTransferOutcome, StartTransferRequest, TransferJob } from '@shared/types/transfers'
import { transfersService } from '@renderer/services/transfers.service'
import { describeSkipped, summarizeQueue, type QueueSummary } from '@renderer/utils/transfer-format'

export type PendingConflict = Extract<StartTransferOutcome, { status: 'conflict' }> & { request: StartTransferRequest }
type Queued = Extract<StartTransferOutcome, { status: 'queued' }>

export interface TransferQueueHooks {
  /** A request was queued (its folders now exist at the destination). */
  onQueued?: (request: StartTransferRequest, outcome: Queued) => void
  /** Jobs that completed since the last call. */
  onCompleted?: (jobs: TransferJob[]) => void
}

export interface TransferQueueState {
  /** In the order they were queued. */
  jobs: TransferJob[]
  summary: QueueSummary
  /** A request is being planned (walking folders can take a moment). */
  preparing: boolean
  conflict: PendingConflict | null
  /** Something the user should know about a request that was queued, e.g. skipped items. */
  notice: string | null
  /** A request or action that was refused. */
  refusal: AppErrorPayload | null
  start: (request: Omit<StartTransferRequest, 'onConflict'>) => Promise<void>
  resolveConflict: (choice: Exclude<ConflictResolution, 'ask'>) => Promise<void>
  cancelConflict: () => void
  cancel: (id: string) => void
  cancelAll: () => void
  retry: (id: string) => void
  retryFailed: () => void
  clearFinished: () => void
  refuse: (message: string) => void
  dismissNotice: () => void
  dismissRefusal: () => void
  /** Queued or running jobs on a connection, e.g. before disconnecting it. */
  activeCountFor: (connectionId: string) => number
}

/**
 * Mirrors the main process's transfer queue (Milestone 7). Updates are applied
 * at most once per frame: a busy queue sends many small updates, and a large
 * request arrives as thousands of jobs at once.
 */
export function useTransferQueue(hooks: TransferQueueHooks = {}): TransferQueueState {
  const jobsRef = useRef(new Map<string, TransferJob>())
  const [version, setVersion] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [conflict, setConflict] = useState<PendingConflict | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<AppErrorPayload | null>(null)
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(() => {
    let frame: number | null = null
    let completed: TransferJob[] = []
    const flush = (): void => {
      frame = null
      setVersion((value) => value + 1)
      if (completed.length > 0) {
        const done = completed
        completed = []
        hooksRef.current.onCompleted?.(done)
      }
    }
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(flush)
    }

    const unsubscribe = transfersService.onUpdate(({ upserts, removals }) => {
      const jobs = jobsRef.current
      for (const job of upserts) {
        if (job.status === 'completed' && jobs.get(job.id)?.status !== 'completed') completed.push(job)
        jobs.set(job.id, job)
      }
      for (const id of removals) jobs.delete(id)
      schedule()
    })

    // After a renderer reload, pick up what the main process is already doing.
    transfersService
      .list()
      .then((listed) => {
        const jobs = jobsRef.current
        const merged = new Map(listed.map((job) => [job.id, jobs.get(job.id) ?? job]))
        for (const [id, job] of jobs) if (!merged.has(id)) merged.set(id, job)
        jobsRef.current = merged
        schedule()
      })
      .catch((cause: AppErrorPayload) => setRefusal(cause))

    return () => {
      unsubscribe()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // The map is mutated in place; `version` changes whenever it does.
  const jobs = useMemo(() => [...jobsRef.current.values()], [version])
  const summary = useMemo(() => summarizeQueue(jobs), [jobs])

  const request = useCallback(async (full: StartTransferRequest) => {
    setRefusal(null)
    setNotice(null)
    setConflict(null)
    setPreparing(true)
    try {
      const outcome = await transfersService.start(full)
      if (outcome.status === 'conflict') {
        setConflict({ ...outcome, request: full })
        return
      }
      const skipped = describeSkipped(outcome.skipped, outcome.skippedCount)
      if (outcome.jobCount === 0 && skipped === '') {
        setNotice(outcome.folderCount > 0 ? 'The folder was created. It has no files to transfer.' : 'There was nothing to transfer.')
      } else if (skipped !== '') {
        setNotice(skipped)
      }
      hooksRef.current.onQueued?.(full, outcome)
    } catch (cause) {
      setRefusal(cause as AppErrorPayload)
    } finally {
      setPreparing(false)
    }
  }, [])

  const act = useCallback((action: () => Promise<unknown>) => {
    setRefusal(null)
    action().catch((cause: AppErrorPayload) => setRefusal(cause))
  }, [])

  const start = useCallback(
    (partial: Omit<StartTransferRequest, 'onConflict'>) => request({ ...partial, onConflict: 'ask' }),
    [request]
  )

  const resolveConflict = useCallback(
    async (choice: Exclude<ConflictResolution, 'ask'>) => {
      if (conflict === null) return
      await request({ ...conflict.request, onConflict: choice })
    },
    [conflict, request]
  )

  const activeCountFor = useCallback(
    (connectionId: string) =>
      jobs.filter((job) => job.connectionId === connectionId && (job.status === 'queued' || job.status === 'running')).length,
    [jobs]
  )

  return {
    jobs,
    summary,
    preparing,
    conflict,
    notice,
    refusal,
    start,
    resolveConflict,
    cancelConflict: useCallback(() => setConflict(null), []),
    cancel: useCallback((id: string) => act(() => transfersService.cancel(id)), [act]),
    cancelAll: useCallback(() => act(() => transfersService.cancelAll()), [act]),
    retry: useCallback((id: string) => act(() => transfersService.retry(id)), [act]),
    retryFailed: useCallback(() => act(() => transfersService.retryFailed()), [act]),
    clearFinished: useCallback(() => act(() => transfersService.clearFinished()), [act]),
    refuse: useCallback((message: string) => setRefusal({ code: 'INVALID_INPUT', message }), []),
    dismissNotice: useCallback(() => setNotice(null), []),
    dismissRefusal: useCallback(() => setRefusal(null), []),
    activeCountFor
  }
}
