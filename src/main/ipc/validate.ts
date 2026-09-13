import { isAbsolute, posix, resolve } from 'node:path'
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

/**
 * Remote paths are always POSIX, whatever OS Fly runs on. Accepts only absolute
 * paths and returns them normalised, without a trailing slash.
 */
export function assertRemotePath(value: unknown, field: string): string {
  const path = assertString(value, field, MAX_PATH_LENGTH)
  if (path.includes('\0')) {
    throw new AppError('INVALID_INPUT', `"${field}" contains an invalid character.`)
  }
  if (!path.startsWith('/')) {
    throw new AppError('INVALID_INPUT', `"${field}" must be an absolute path.`)
  }
  return posix.resolve(path)
}

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', `Expected "${field}" to be an object.`)
  }
  return value as Record<string, unknown>
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A host name or IP address: no whitespace or control characters, DNS length limit. */
export function assertHost(value: unknown, field = 'host'): string {
  const host = assertString(value, field, 253)
  if (host.length === 0 || /\s/.test(host) || hasControlCharacter(host)) {
    throw new AppError('INVALID_INPUT', `"${field}" must be a host name or IP address.`)
  }
  return host
}

export function assertPort(value: unknown, field = 'port'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AppError('INVALID_INPUT', `"${field}" must be a whole number from 1 to 65535.`)
  }
  return value
}

export function assertUsername(value: unknown, field = 'username'): string {
  const username = assertString(value, field, 128)
  if (username.length === 0 || hasControlCharacter(username)) {
    throw new AppError('INVALID_INPUT', `"${field}" must not be empty or contain control characters.`)
  }
  return username
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new AppError('INVALID_INPUT', `Expected "${field}" to be true or false.`)
  return value
}

/** A display name: may be empty only where the caller allows it. */
export function assertName(value: unknown, field = 'name', { allowEmpty = false } = {}): string {
  const name = assertString(value, field, 100).trim()
  if ((!allowEmpty && name.length === 0) || hasControlCharacter(name)) {
    throw new AppError('INVALID_INPUT', `"${field}" must not be empty or contain control characters.`)
  }
  return name
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function assertUuid(value: unknown, field: string): string {
  const id = assertString(value, field, 36)
  if (!UUID.test(id)) throw new AppError('INVALID_INPUT', `"${field}" is not a valid identifier.`)
  return id
}
