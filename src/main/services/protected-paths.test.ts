import { describe, expect, it } from 'vitest'
import { isProtectedPath } from './protected-paths'

describe('isProtectedPath', () => {
  it.each(['/', '/Users', '/Users/me'])('protects %s on POSIX (the root, the home folder and its ancestors)', (path) => {
    expect(isProtectedPath(path, '/Users/me', 'posix')).toBe(true)
  })

  it.each(['/Users/me/Documents', '/Users/me2', '/Users/m', '/tmp', '/Users/other'])('allows %s on POSIX', (path) => {
    expect(isProtectedPath(path, '/Users/me', 'posix')).toBe(false)
  })

  it.each(['C:\\', 'c:\\users', 'C:\\Users\\Me', 'D:\\'])('protects %s on Windows, ignoring case', (path) => {
    expect(isProtectedPath(path, 'C:\\Users\\me', 'win32')).toBe(true)
  })

  it.each(['C:\\Users\\me\\Desktop', 'C:\\Users\\me2', 'D:\\data'])('allows %s on Windows', (path) => {
    expect(isProtectedPath(path, 'C:\\Users\\me', 'win32')).toBe(false)
  })
})
