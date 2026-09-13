/**
 * Whether a single file or folder name can be created (Milestone 8 plan D2).
 * Shared so the renderer can explain a problem as it is typed and the main
 * process can enforce the same rules. Pure: no Node or DOM.
 *
 * `platform` is a Node platform name; anything but "win32" gets POSIX rules,
 * which is also what every remote (SFTP) path uses.
 */

const WINDOWS_FORBIDDEN = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export const MAX_NAME_LENGTH = 255

export function nameProblem(name: string, platform: string): string | null {
  if (name.trim() === '') return 'Enter a name.'
  if (name === '.' || name === '..') return 'A name can\'t be "." or "..".'
  if (name.length > MAX_NAME_LENGTH) return `A name can be at most ${MAX_NAME_LENGTH} characters.`
  for (const character of name) {
    if (character.charCodeAt(0) === 0) return "A name can't contain control characters."
    if (character === '/') return 'A name can\'t contain "/".'
  }
  if (platform !== 'win32') return null

  for (const character of name) {
    if (character.charCodeAt(0) < 32) return "A name can't contain control characters."
    if (WINDOWS_FORBIDDEN.has(character)) return 'A name can\'t contain any of these characters on Windows: \\ / : * ? " < > |'
  }
  if (/[. ]$/.test(name)) return "A name can't end with a space or a period on Windows."
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is reserved by Windows.`
  return null
}

/** The part of a name to preselect when renaming: everything before the extension, as Finder does. */
export function baseNameLength(name: string, isFolder: boolean): number {
  if (isFolder) return name.length
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name.length : dot
}
