import { describe, expect, it } from 'vitest'
import { AppError } from '../errors'
import { assertTransferName, firstFreeName, numberedName, temporaryName } from './names'

describe('assertTransferName', () => {
  it.each(['report.pdf', 'spaced name.txt', 'ünïcödé 文件.bin', '.hidden'])('accepts %j', (name) => {
    expect(assertTransferName(name, 'darwin')).toBe(name)
  })

  it.each(['', '.', '..', 'a/b', `nul${String.fromCharCode(0)}byte`, 'x'.repeat(256)])('refuses %j everywhere', (name) => {
    expect(() => assertTransferName(name, 'linux')).toThrow(AppError)
  })

  it('refuses characters Windows cannot store, only on Windows', () => {
    for (const name of ['a\\b', 'c:d', 'what?', 'pipe|name']) {
      expect(() => assertTransferName(name, 'win32')).toThrow(AppError)
      expect(assertTransferName(name, 'darwin')).toBe(name)
    }
  })
})

describe('keep both', () => {
  it.each([
    ['report.pdf', 1, 'report (1).pdf'],
    ['archive.tar.gz', 2, 'archive.tar (2).gz'],
    ['Makefile', 1, 'Makefile (1)'],
    ['.bashrc', 1, '.bashrc (1)']
  ])('numbers %s as %s', (name, n, expected) => {
    expect(numberedName(name, n)).toBe(expected)
  })

  it('finds the first free number', async () => {
    const taken = new Set(['report (1).pdf', 'report (2).pdf'])
    expect(await firstFreeName('report.pdf', async (candidate) => taken.has(candidate))).toBe('report (3).pdf')
  })
})

describe('temporaryName', () => {
  it('is hidden, marked, and bounded in length', () => {
    expect(temporaryName('report.pdf', 'abc123')).toBe('.report.pdf.fly-part-abc123')
    expect(temporaryName('x'.repeat(300), 'abc123').length).toBeLessThanOrEqual(220)
  })
})
