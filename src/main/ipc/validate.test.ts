import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError } from '../errors'
import {
  assertAbsolutePath,
  assertHost,
  assertObject,
  assertPort,
  assertRemotePath,
  assertUsername,
  assertUuid
} from './validate'

describe('connection input validators', () => {
  it.each(['example.com', '192.168.1.10', '::1', 'fe80::1%en0', 'a'.repeat(253)])('accepts the host %s', (host) => {
    expect(assertHost(host)).toBe(host)
  })

  it.each(['', ' example.com', 'exa mple.com', 'host\n', 'tab\there', 'bell\u0007', 'a'.repeat(254), 42])(
    'rejects the host %j',
    (host) => {
      expect(() => assertHost(host)).toThrow(AppError)
    }
  )

  it.each([1, 22, 2222, 65535])('accepts port %s', (port) => {
    expect(assertPort(port)).toBe(port)
  })

  it.each([0, 65536, -1, 22.5, '22', Number.NaN, null])('rejects port %j', (port) => {
    expect(() => assertPort(port)).toThrow(/1 to 65535/)
  })

  it('accepts ordinary usernames, including ones with spaces', () => {
    expect(assertUsername('ubuntu')).toBe('ubuntu')
    expect(assertUsername('Jane Doe')).toBe('Jane Doe')
  })

  it.each(['', 'root\u0000', 'x\r\ny', 'a'.repeat(129)])('rejects the username %j', (username) => {
    expect(() => assertUsername(username)).toThrow(AppError)
  })

  it('accepts a UUID and rejects anything else', () => {
    expect(assertUuid('3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b', 'id')).toBe('3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b')
    for (const bad of ['', 'not-a-uuid', '3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b', '../../etc', 7]) {
      expect(() => assertUuid(bad, 'id')).toThrow(AppError)
    }
  })

  it('accepts only plain objects', () => {
    expect(assertObject({ a: 1 }, 'request')).toEqual({ a: 1 })
    for (const bad of [null, [], 'text', 3]) expect(() => assertObject(bad, 'request')).toThrow(/object/)
  })
})

describe('assertRemotePath', () => {
  it.each([
    ['/', '/'],
    ['/config', '/config'],
    ['/config/', '/config'],
    ['/a/b/../c', '/a/c'],
    ['//double//slash', '/double/slash'],
    ['/../..', '/']
  ])('normalises %s to %s as a POSIX path', (input, expected) => {
    expect(assertRemotePath(input, 'path')).toBe(expected)
  })

  it.each(['relative', '~/x', 'C:\\Users', ''])('rejects the non-absolute path %j', (path) => {
    expect(() => assertRemotePath(path, 'path')).toThrow(/absolute path/)
  })

  it('rejects a NUL byte and an over-long path', () => {
    expect(() => assertRemotePath('/a\0b', 'path')).toThrow(/invalid character/)
    expect(() => assertRemotePath(`/${'a'.repeat(5000)}`, 'path')).toThrow(/too long/)
  })
})

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
