import { describe, expect, it } from 'vitest'
import { baseNameLength, nameProblem } from './names'

describe('nameProblem', () => {
  it.each(['report.pdf', 'spaced name', 'ünïcödé 文件', '.hidden', 'trailing.', 'a:b', 'CON'])('accepts %j on POSIX', (name) => {
    expect(nameProblem(name, 'linux')).toBeNull()
    expect(nameProblem(name, 'darwin')).toBeNull()
  })

  it.each([
    ['', 'Enter a name.'],
    ['   ', 'Enter a name.'],
    ['.', 'A name can\'t be "." or "..".'],
    ['..', 'A name can\'t be "." or "..".'],
    ['a/b', 'A name can\'t contain "/".'],
    [`nul${String.fromCharCode(0)}`, "A name can't contain control characters."],
    ['x'.repeat(256), 'A name can be at most 255 characters.']
  ])('refuses %j everywhere', (name, message) => {
    expect(nameProblem(name, 'linux')).toBe(message)
    expect(nameProblem(name, 'win32')).toBe(message)
  })

  it.each(['a\\b', 'a:b', 'what?', 'pipe|name', 'quote"', 'tab\tname', 'trailing.', 'trailing ', 'CON', 'com1.txt', 'LPT9'])(
    'refuses %j on Windows only',
    (name) => {
      expect(nameProblem(name, 'win32')).not.toBeNull()
      expect(nameProblem(name, 'linux')).toBeNull()
    }
  )

  it('allows a name that merely starts like a reserved one on Windows', () => {
    expect(nameProblem('console.log', 'win32')).toBeNull()
  })
})

describe('baseNameLength', () => {
  it('selects the name without its extension, but all of a folder or a dotfile', () => {
    expect(baseNameLength('report.final.pdf', false)).toBe('report.final'.length)
    expect(baseNameLength('.bashrc', false)).toBe('.bashrc'.length)
    expect(baseNameLength('Makefile', false)).toBe('Makefile'.length)
    expect(baseNameLength('photos.2024', true)).toBe('photos.2024'.length)
  })
})
