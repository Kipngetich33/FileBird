import { IPC } from '../../shared/constants/channels'
import {
  MAX_TRANSFER_SOURCES,
  type ConflictResolution,
  type StartTransferOutcome,
  type StartTransferRequest,
  type TransferDirection,
  type TransferJob
} from '../../shared/types/transfers'
import { AppError } from '../errors'
import type { TransferQueue } from '../transfers/queue'
import { handle } from './handle'
import { assertAbsolutePath, assertObject, assertRemotePath, assertUuid } from './validate'

const DIRECTIONS: readonly TransferDirection[] = ['upload', 'download']
const RESOLUTIONS: readonly ConflictResolution[] = ['ask', 'replace', 'keep-both', 'skip']

/** Rebuilt field by field; which side each path lives on decides how it is validated. */
function assertStartRequest(value: unknown): StartTransferRequest {
  const request = assertObject(value, 'transfer')
  const direction = request['direction']
  const onConflict = request['onConflict']
  if (!DIRECTIONS.includes(direction as TransferDirection)) throw new AppError('INVALID_INPUT', 'Unknown transfer direction.')
  if (!RESOLUTIONS.includes(onConflict as ConflictResolution)) throw new AppError('INVALID_INPUT', 'Unknown conflict resolution.')
  const sources = request['sourcePaths']
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_TRANSFER_SOURCES) {
    throw new AppError('INVALID_INPUT', `Choose between 1 and ${MAX_TRANSFER_SOURCES} items to transfer.`)
  }
  const upload = direction === 'upload'
  const sourcePath = upload ? assertAbsolutePath : assertRemotePath
  const destinationPath = upload ? assertRemotePath : assertAbsolutePath
  return {
    connectionId: assertUuid(request['connectionId'], 'connectionId'),
    direction: direction as TransferDirection,
    sourcePaths: sources.map((path: unknown) => sourcePath(path, 'sourcePaths')),
    destinationDirectory: destinationPath(request['destinationDirectory'], 'destinationDirectory'),
    onConflict: onConflict as ConflictResolution
  }
}

/** The transfer queue (Milestones 6–7). Updates are pushed from main.ts. */
export function registerTransfersIpc(queue: TransferQueue): void {
  handle<StartTransferOutcome>(IPC.TRANSFERS_START, (request) => queue.start(assertStartRequest(request)))
  handle<void>(IPC.TRANSFERS_CANCEL, (id) => queue.cancel(assertUuid(id, 'id')))
  handle<void>(IPC.TRANSFERS_CANCEL_ALL, () => queue.cancelAll())
  handle<void>(IPC.TRANSFERS_RETRY, (id) => queue.retry(assertUuid(id, 'id')))
  handle<number>(IPC.TRANSFERS_RETRY_FAILED, () => queue.retryFailed())
  handle<void>(IPC.TRANSFERS_CLEAR_FINISHED, () => queue.clearFinished())
  handle<TransferJob[]>(IPC.TRANSFERS_LIST, () => queue.list())
}
