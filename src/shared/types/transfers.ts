import type { AppErrorPayload } from './errors'

/**
 * The transfer queue (Milestones 6–7). The main process plans and runs every
 * transfer; the renderer asks for one and mirrors the queue from updates.
 */

export type TransferDirection = 'upload' | 'download'

/** Spec section 13. */
export type TransferStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** What to do with names that already exist at the destination. */
export type ConflictResolution = 'ask' | 'replace' | 'keep-both' | 'skip'

export const MAX_TRANSFER_SOURCES = 1_000

export interface StartTransferRequest {
  connectionId: string
  direction: TransferDirection
  /** Absolute local paths for uploads, remote POSIX paths for downloads. Distinct names. */
  sourcePaths: string[]
  /** The folder to transfer into, on the other side. */
  destinationDirectory: string
  onConflict: ConflictResolution
}

export interface FileFacts {
  size: number | null
  modifiedAt: number | null
  isDirectory: boolean
}

export interface TransferConflict {
  name: string
  existing: FileFacts
  incoming: FileFacts
  /** False when the kinds differ: a file never replaces a folder, or the reverse. */
  canReplace: boolean
}

export type SkipReason = 'link-to-folder' | 'special' | 'unreadable' | 'kind-mismatch' | 'exists' | 'invalid-name'

export interface SkippedItem {
  /** Relative to the request's destination folder, e.g. "photos/link". */
  path: string
  reason: SkipReason
}

/** Lists in outcomes are capped; the counts are not. */
export const OUTCOME_LIST_LIMIT = 50

export type StartTransferOutcome =
  | {
      status: 'queued'
      batchId: string
      jobCount: number
      /** Folders created at the destination, including empty ones. */
      folderCount: number
      skipped: SkippedItem[]
      skippedCount: number
    }
  /** Something already exists; ask the user, then start again with a resolution. Nothing was touched. */
  | { status: 'conflict'; conflicts: TransferConflict[]; conflictCount: number; itemCount: number }

export interface TransferServer {
  host: string
  port: number
  username: string
}

/** One file in the queue. */
export interface TransferJob {
  id: string
  /** Jobs from one request share a batch. */
  batchId: string
  connectionId: string
  server: TransferServer
  direction: TransferDirection
  name: string
  /** The path inside the batch, e.g. "photos/2024/a.jpg"; just the name for a single file. */
  relativePath: string
  sourcePath: string
  destinationPath: string
  destinationDirectory: string
  /** The folder the request transferred into. */
  batchDestination: string
  transferredBytes: number
  /** Known from planning; refreshed when the job starts. */
  totalBytes: number | null
  /** Averaged over the last couple of seconds. */
  bytesPerSecond: number
  status: TransferStatus
  error: AppErrorPayload | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  attempt: number
}

/** Pushed from main: changed or added jobs, and jobs removed from the history. */
export interface TransferQueueUpdate {
  upserts: TransferJob[]
  removals: string[]
}
