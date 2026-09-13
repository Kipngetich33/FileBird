import { posix, win32 } from 'node:path'

/**
 * Paths Fly refuses to delete or rename (Milestone 8 plan D3): the filesystem
 * root, the home folder, and every folder that contains the home folder.
 * Paths must already be absolute and normalised.
 */
export function isProtectedPath(path: string, home: string, style: 'posix' | 'win32'): boolean {
  if (style === 'win32') {
    const target = win32.resolve(path).toLowerCase()
    const own = win32.resolve(home).toLowerCase()
    if (win32.parse(target).root === target) return true
    return own === target || own.startsWith(target.endsWith('\\') ? target : `${target}\\`)
  }
  const target = posix.resolve(path)
  const own = posix.resolve(home)
  if (target === '/') return true
  return own === target || own.startsWith(`${target}/`)
}
