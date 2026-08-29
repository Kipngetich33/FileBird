/**
 * Shape of every error that crosses the IPC boundary.
 *
 * Spec section 17: the renderer receives a user-friendly message and a stable
 * code. Stack traces stay in the main process and go to the log only.
 */
export interface AppErrorPayload {
  code: AppErrorCode
  message: string
}

export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'INTERNAL'

export const isAppErrorPayload = (value: unknown): value is AppErrorPayload =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  'message' in value
