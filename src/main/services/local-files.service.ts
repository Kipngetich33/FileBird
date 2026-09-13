import type { Stats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DirectoryListing, FileEntry, FileKind } from '../../shared/types/files'
import { fromFsError } from '../errors'

/**
 * Local filesystem access. Node's `fs` lives here and never crosses IPC — the
 * renderer receives only the plain data below.
 *
 * Deliberately free of any `electron` import so it can be unit-tested against
 * a real temporary directory.
 */

/** `path` must already be absolute and normalised (see `assertAbsolutePath`). */
export async function listDirectory(path: string): Promise<DirectoryListing> {
  let names: string[]
  try {
    names = await readdir(path)
  } catch (error) {
    throw fromFsError(error) ?? error
  }

  const entries = await Promise.all(names.map((name) => readEntry(path, name)))
  const parent = dirname(path)

  return { path, parentPath: parent === path ? null : parent, entries }
}

/**
 * Describes one directory entry. Never throws: an entry that cannot be stat'ed
 * is still listed with null metadata, so one unreadable file cannot blank the
 * whole listing.
 */
export async function readEntry(directory: string, name: string): Promise<FileEntry> {
  const path = join(directory, name)
  const base = { name, path, isHidden: name.startsWith('.') }

  let own: Stats
  try {
    own = await lstat(path)
  } catch {
    return { ...base, kind: 'other', isSymlink: false, size: null, modifiedAt: null }
  }

  if (!own.isSymbolicLink()) return { ...base, ...describe(own), isSymlink: false }

  try {
    // Follow the link so a link to a folder can be opened like one.
    return { ...base, ...describe(await stat(path)), isSymlink: true }
  } catch {
    return { ...base, kind: 'other', isSymlink: true, size: null, modifiedAt: own.mtimeMs }
  }
}

function describe(stats: Stats): Pick<FileEntry, 'kind' | 'size' | 'modifiedAt'> {
  const kind: FileKind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
  return { kind, size: kind === 'file' ? stats.size : null, modifiedAt: stats.mtimeMs }
}
