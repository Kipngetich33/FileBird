import type { AppErrorCode, AppErrorPayload } from '../../shared/types/errors'

/**
 * Input arriving from the renderer is untrusted (spec section 20).
 *
 * Handlers validate every argument through these helpers. A failure throws an
 * AppError, which `handle()` converts into a safe payload — the renderer never
 * sees a stack trace.
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

export function assertString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string') {
    throw new AppError('INVALID_INPUT', `Expected "${field}" to be text.`)
  }
  if (value.length > maxLength) {
    throw new AppError('INVALID_INPUT', `"${field}" is too long (limit ${maxLength}).`)
  }
  return value
}
