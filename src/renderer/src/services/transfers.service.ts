import type { StartTransferOutcome, StartTransferRequest, TransferUpdate } from '@shared/types/transfers'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Uploads and downloads. The main process runs them and reports progress. */
export const transfersService = {
  start: (request: StartTransferRequest): Promise<StartTransferOutcome> => call(() => window.api.transfers.start(request)),

  cancel: (id: string): Promise<void> => call(() => window.api.transfers.cancel(id)),

  /** Returns an unsubscribe function. */
  onUpdate: (listener: (update: TransferUpdate) => void): (() => void) => window.api.transfers.onUpdate(listener)
}
