import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError } from '../errors'
import { assertAbsolutePath } from './validate'

describe('assertAbsolutePath', () => {
  it('returns an absolute path normalised', () => {
    expect(assertAbsolutePath('/tmp/a/../b/', 'path')).toBe(resolve('/tmp/b'))
  })

  it.each([
    ['a relative path', 'relative/dir'],
    ['a dot path', '.'],
    ['a parent reference', '../etc'],
    ['an empty string', '']
  ])('rejects %s', (_label, value) => {
    expect(() => assertAbsolutePath(value, 'path')).toThrow(/absolute path/)
  })

  it('rejects a NUL byte, which could truncate the path at the OS layer', () => {
    expect(() => assertAbsolutePath('/tmp/ok\0/../../etc', 'path')).toThrow(/invalid character/)
  })

  it.each([[42], [null], [undefined], [{}], [['/tmp']]])('rejects the non-string %j', (value) => {
    expect(() => assertAbsolutePath(value, 'path')).toThrow(/to be text/)
  })

  it('rejects an over-long path', () => {
    expect(() => assertAbsolutePath(`/${'a'.repeat(5000)}`, 'path')).toThrow(/too long/)
  })

  it('fails with an INVALID_INPUT AppError, which handle() passes to the user', () => {
    try {
      assertAbsolutePath('nope', 'path')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('INVALID_INPUT')
    }
  })
})
