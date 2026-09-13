import { useCallback, useEffect, useState } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { ConflictResolution, StartTransferOutcome, StartTransferRequest, TransferUpdate } from '@shared/types/transfers'
import { transfersService } from '@renderer/services/transfers.service'

export type TransferConflict = Extract<StartTransferOutcome, { status: 'conflict' }> & { request: StartTransferRequest }

export interface TransfersState {
  /** The running transfer, or the last one to finish until dismissed. */
  transfer: TransferUpdate | null
  running: boolean
  /** The destination has a file of that name; waiting for the user's choice. */
  conflict: TransferConflict | null
  /** A transfer that was refused before it began, e.g. a missing file. */
  refusal: AppErrorPayload | null
  start: (request: Omit<StartTransferRequest, 'onConflict'>) => Promise<void>
  resolveConflict: (choice: Exclude<ConflictResolution, 'ask'>) => Promise<void>
  cancelConflict: () => void
  /** Reports a transfer that couldn't be requested at all, e.g. nothing selected. */
  refuse: (message: string) => void
  cancel: () => void
  /** Clears a finished transfer from view. */
  dismiss: () => void
  dismissRefusal: () => void
}

/**
 * The transfer the main process is running (Milestone 6: one at a time). The
 * main process owns it; this mirrors its updates for display.
 */
export function useTransfers(): TransfersState {
  const [transfer, setTransfer] = useState<TransferUpdate | null>(null)
  const [conflict, setConflict] = useState<TransferConflict | null>(null)
  const [refusal, setRefusal] = useState<AppErrorPayload | null>(null)

  useEffect(() => transfersService.onUpdate(setTransfer), [])

  const request = useCallback(async (full: StartTransferRequest) => {
    setRefusal(null)
    setConflict(null)
    try {
      const outcome = await transfersService.start(full)
      if (outcome.status === 'conflict') {
        setConflict({ ...outcome, request: full })
        return
      }
      // Updates can arrive before this reply, a short transfer's "completed"
      // among them; never step back to the "started" snapshot.
      setTransfer((current) => (current?.id === outcome.transfer.id ? current : outcome.transfer))
    } catch (cause) {
      setRefusal(cause as AppErrorPayload)
    }
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

  const cancel = useCallback(() => {
    if (transfer?.status !== 'running') return
    transfersService.cancel(transfer.id).catch((cause: AppErrorPayload) => setRefusal(cause))
  }, [transfer])

  const running = transfer?.status === 'running'

  return {
    transfer,
    running,
    conflict,
    refusal,
    start,
    resolveConflict,
    cancelConflict: useCallback(() => setConflict(null), []),
    refuse: useCallback((message: string) => setRefusal({ code: 'INVALID_INPUT', message }), []),
    cancel,
    dismiss: useCallback(() => setTransfer((current) => (current?.status === 'running' ? current : null)), []),
    dismissRefusal: useCallback(() => setRefusal(null), [])
  }
}
