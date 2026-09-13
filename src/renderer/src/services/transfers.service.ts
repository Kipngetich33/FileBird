import type { StartTransferOutcome, StartTransferRequest, TransferJob, TransferQueueUpdate } from '@shared/types/transfers'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** The transfer queue. The main process plans and runs transfers and pushes every change. */
export const transfersService = {
  start: (request: StartTransferRequest): Promise<StartTransferOutcome> => call(() => window.api.transfers.start(request)),
  cancel: (id: string): Promise<void> => call(() => window.api.transfers.cancel(id)),
  cancelAll: (): Promise<void> => call(() => window.api.transfers.cancelAll()),
  retry: (id: string): Promise<void> => call(() => window.api.transfers.retry(id)),
  retryFailed: (): Promise<number> => call(() => window.api.transfers.retryFailed()),
  clearFinished: (): Promise<void> => call(() => window.api.transfers.clearFinished()),
  list: (): Promise<TransferJob[]> => call(() => window.api.transfers.list()),

  /** Returns an unsubscribe function. */
  onUpdate: (listener: (update: TransferQueueUpdate) => void): (() => void) => window.api.transfers.onUpdate(listener)
}
