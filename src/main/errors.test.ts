import { describe, expect, it } from 'vitest'
import { AppError, fromFsError } from './errors'

const fsError = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

describe('fromFsError', () => {
  it.each([
    ['ENOENT', 'NOT_FOUND'],
    ['ENOTDIR', 'NOT_A_DIRECTORY'],
    ['EACCES', 'PERMISSION_DENIED'],
    ['EPERM', 'PERMISSION_DENIED']
  ])('maps %s to %s', (errno, code) => {
    const mapped = fromFsError(fsError(errno), 'linux')
    expect(mapped).toBeInstanceOf(AppError)
    expect(mapped?.code).toBe(code)
  })

  it('points a macOS EPERM at the privacy settings, but not a plain EACCES', () => {
    expect(fromFsError(fsError('EPERM'), 'darwin')?.message).toContain('Privacy & Security')
    expect(fromFsError(fsError('EACCES'), 'darwin')?.message).not.toContain('Privacy')
    expect(fromFsError(fsError('EPERM'), 'win32')?.message).not.toContain('Privacy')
  })

  it('never copies the raw system message, which contains the path, into the user message', () => {
    const raw = fsError('ENOENT', "ENOENT: no such file or directory, scandir '/secret/place'")
    expect(fromFsError(raw)?.message).not.toContain('/secret/place')
  })

  it('returns null for failures the user cannot act on, so they are logged in full', () => {
    expect(fromFsError(fsError('EIO'))).toBeNull()
    expect(fromFsError(new Error('no code'))).toBeNull()
    expect(fromFsError({ code: 42 })).toBeNull()
    expect(fromFsError('text')).toBeNull()
    expect(fromFsError(null)).toBeNull()
  })
})
