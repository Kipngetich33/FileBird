import { IPC } from '../../shared/constants/channels'
import type {
  ConflictResolution,
  StartTransferOutcome,
  StartTransferRequest,
  TransferDirection
} from '../../shared/types/transfers'
import { AppError } from '../errors'
import type { TransferService } from '../transfers/transfer.service'
import { handle } from './handle'
import { assertAbsolutePath, assertObject, assertRemotePath, assertUuid } from './validate'

const DIRECTIONS: readonly TransferDirection[] = ['upload', 'download']
const RESOLUTIONS: readonly ConflictResolution[] = ['ask', 'replace', 'keep-both']

/** Rebuilt field by field; which side each path lives on decides how it is validated. */
function assertStartRequest(value: unknown): StartTransferRequest {
  const request = assertObject(value, 'transfer')
  const direction = request['direction']
  const onConflict = request['onConflict']
  if (!DIRECTIONS.includes(direction as TransferDirection)) throw new AppError('INVALID_INPUT', 'Unknown transfer direction.')
  if (!RESOLUTIONS.includes(onConflict as ConflictResolution)) throw new AppError('INVALID_INPUT', 'Unknown conflict resolution.')
  const upload = direction === 'upload'
  return {
    connectionId: assertUuid(request['connectionId'], 'connectionId'),
    direction: direction as TransferDirection,
    sourcePath: upload ? assertAbsolutePath(request['sourcePath'], 'sourcePath') : assertRemotePath(request['sourcePath'], 'sourcePath'),
    destinationDirectory: upload
      ? assertRemotePath(request['destinationDirectory'], 'destinationDirectory')
      : assertAbsolutePath(request['destinationDirectory'], 'destinationDirectory'),
    onConflict: onConflict as ConflictResolution
  }
}

/** Uploads and downloads (Milestone 6). Progress is pushed from main.ts. */
export function registerTransfersIpc(transfers: TransferService): void {
  handle<StartTransferOutcome>(IPC.TRANSFERS_START, (request) => transfers.start(assertStartRequest(request)))
  handle<void>(IPC.TRANSFERS_CANCEL, (id) => transfers.cancel(assertUuid(id, 'id')))
}
