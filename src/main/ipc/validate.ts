import { isAbsolute, resolve } from 'node:path'
import { AppError } from '../errors'

/**
 * Input arriving from the renderer is untrusted (spec section 20).
 *
 * Handlers validate every argument through these helpers. A failure throws an
 * AppError, which `handle()` converts into a safe payload — the renderer never
 * sees a stack trace.
 */

/** Generous enough for any real path on macOS (1024), Linux (4096) or long Windows paths. */
const MAX_PATH_LENGTH = 4096

export function assertString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string') {
    throw new AppError('INVALID_INPUT', `Expected "${field}" to be text.`)
  }
  if (value.length > maxLength) {
    throw new AppError('INVALID_INPUT', `"${field}" is too long (limit ${maxLength}).`)
  }
  return value
}

/**
 * Accepts only absolute paths and returns them normalised.
 *
 * This checks shape, not location: a file manager must reach the whole disk, so
 * there is deliberately no directory jail here. Relative paths are refused
 * because the renderer only ever sends back paths the main process gave it.
 */
export function assertAbsolutePath(value: unknown, field: string): string {
  const path = assertString(value, field, MAX_PATH_LENGTH)
  if (path.includes('\0')) {
    throw new AppError('INVALID_INPUT', `"${field}" contains an invalid character.`)
  }
  if (!isAbsolute(path)) {
    throw new AppError('INVALID_INPUT', `"${field}" must be an absolute path.`)
  }
  return resolve(path)
}
