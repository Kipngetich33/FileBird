import type { AppErrorPayload } from './errors'

/** Which side a file operation applies to (Milestone 8). */
export type FileTarget = { side: 'local' } | { side: 'remote'; connectionId: string }

export const MAX_DELETE_ITEMS = 1_000

export interface DeleteFailure {
  name: string
  path: string
  error: AppErrorPayload
}

export interface DeleteOutcome {
  deleted: number
  failures: DeleteFailure[]
}

/** Moving items into a folder on the same side (Milestone 12). */
export const MAX_MOVE_ITEMS = 1_000

export interface MoveOutcome {
  moved: number
  /** Items already in that folder: nothing to do, and not a failure. */
  alreadyThere: number
  failures: DeleteFailure[]
}
