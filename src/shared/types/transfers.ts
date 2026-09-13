import type { AppErrorPayload } from './errors'

/**
 * File transfers (Milestone 6). The main process owns every transfer; the
 * renderer asks for one and receives throttled updates.
 */

export type TransferDirection = 'upload' | 'download'

export type TransferStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** What to do when the destination name already exists. */
export type ConflictResolution = 'ask' | 'replace' | 'keep-both'

export interface StartTransferRequest {
  connectionId: string
  direction: TransferDirection
  /** An absolute local path for uploads, a remote POSIX path for downloads. */
  sourcePath: string
  /** The folder to transfer into, on the other side. */
  destinationDirectory: string
  onConflict: ConflictResolution
}

export interface FileFacts {
  size: number | null
  modifiedAt: number | null
  isDirectory: boolean
}

export interface TransferUpdate {
  id: string
  connectionId: string
  direction: TransferDirection
  name: string
  sourcePath: string
  destinationPath: string
  destinationDirectory: string
  transferredBytes: number
  totalBytes: number
  /** Averaged over the last couple of seconds. */
  bytesPerSecond: number
  status: TransferStatus
  error: AppErrorPayload | null
  startedAt: number
  finishedAt: number | null
}

export type StartTransferOutcome =
  | { status: 'started'; transfer: TransferUpdate }
  /** The destination exists; ask the user, then start again with a resolution. */
  | { status: 'conflict'; name: string; existing: FileFacts; incoming: FileFacts; canReplace: boolean }
