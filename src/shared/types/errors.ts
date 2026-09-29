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
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'NOT_A_DIRECTORY'
  | 'HOST_NOT_FOUND'
  | 'CONNECTION_REFUSED'
  | 'UNREACHABLE'
  | 'CONNECTION_TIMED_OUT'
  | 'AUTH_FAILED'
  | 'HANDSHAKE_FAILED'
  | 'CONNECTION_LOST'
  | 'NOT_CONNECTED'
  | 'KEY_NOT_FOUND'
  | 'KEY_UNREADABLE'
  | 'KEY_INVALID'
  | 'KEY_IS_PUBLIC'
  | 'KEY_PASSPHRASE_REQUIRED'
  | 'KEY_PASSPHRASE_INCORRECT'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'SSH_CONFIG_UNAVAILABLE'
  | 'TERMINAL_UNAVAILABLE'
  | 'TRANSFER_FAILED'
  | 'ALREADY_EXISTS'
  | 'NOT_ALLOWED'
  | 'TRASH_UNAVAILABLE'
  | 'DISK_FULL'
  | 'INTERNAL'

export const isAppErrorPayload = (value: unknown): value is AppErrorPayload =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  'message' in value
