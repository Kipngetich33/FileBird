import type { AppErrorCode, AppErrorPayload } from '../shared/types/errors'

/**
 * An error that is safe to show the user.
 *
 * Services and IPC handlers throw these for failures the user can understand.
 * `ipc/handle.ts` turns them into a payload; anything that is not an AppError
 * is logged in full and replaced with a generic message (spec section 17).
 */
export class AppError extends Error {
  readonly code: AppErrorCode

  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }

  toPayload(): AppErrorPayload {
    return { code: this.code, message: this.message }
  }
}

/** The string errno (`ENOENT`, `ECONNREFUSED`, …) Node attaches to system errors. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Translates a Node filesystem error into an AppError, or returns null when the
 * failure is not one the user can act on — callers rethrow the original so it
 * is logged in full.
 *
 * On macOS, EPERM from a plain read almost always means the privacy system
 * (TCC) blocked the folder, which unix permissions report as EACCES instead.
 */
export function fromFsError(error: unknown, platform: NodeJS.Platform = process.platform): AppError | null {
  switch (errnoOf(error)) {
    case 'ENOENT':
      return new AppError('NOT_FOUND', 'This folder no longer exists. It may have been moved or deleted.')
    case 'ENOTDIR':
      return new AppError('NOT_A_DIRECTORY', 'This is a file, not a folder.')
    case 'EPERM':
      if (platform === 'darwin') {
        return new AppError(
          'PERMISSION_DENIED',
          'macOS blocked access to this folder. You can allow it in System Settings › Privacy & Security › Files and Folders.'
        )
      }
      return new AppError('PERMISSION_DENIED', "You don't have permission to open this folder.")
    case 'EACCES':
      return new AppError('PERMISSION_DENIED', "You don't have permission to open this folder.")
    default:
      return null
  }
}
