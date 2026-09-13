import { posix } from 'node:path'
import type { FileEntry, FileKind } from '../../shared/types/files'

/**
 * SFTP attributes → FileEntry. Pure apart from the injected `statTarget`, so it
 * is unit-testable without a server.
 *
 * SFTP folder listings describe symlinks as links (lstat-style), and attribute
 * fields are optional in the protocol, so every field may be missing.
 */
export interface RemoteAttributes {
  mode?: number
  size?: number
  /** Seconds since the epoch, as SFTP sends it. */
  mtime?: number
}

export interface RawRemoteEntry {
  filename: string
  attrs: RemoteAttributes
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export function isSymlinkMode(mode: number | undefined): boolean {
  return mode !== undefined && (mode & S_IFMT) === S_IFLNK
}

export function kindOfMode(mode: number | undefined): FileKind {
  if (mode === undefined) return 'other'
  const type = mode & S_IFMT
  return type === S_IFDIR ? 'directory' : type === S_IFREG ? 'file' : 'other'
}

function describe(attrs: RemoteAttributes): Pick<FileEntry, 'kind' | 'size' | 'modifiedAt'> {
  const kind = kindOfMode(attrs.mode)
  return {
    kind,
    size: kind === 'file' && attrs.size !== undefined ? attrs.size : null,
    modifiedAt: attrs.mtime !== undefined ? attrs.mtime * 1000 : null
  }
}

/** Never throws: a link whose target cannot be stat'ed is reported as a broken link. */
export async function toRemoteEntry(
  directory: string,
  raw: RawRemoteEntry,
  statTarget: (path: string) => Promise<RemoteAttributes>
): Promise<FileEntry> {
  const path = posix.join(directory, raw.filename)
  const base = { name: raw.filename, path, isHidden: raw.filename.startsWith('.') }

  if (!isSymlinkMode(raw.attrs.mode)) return { ...base, ...describe(raw.attrs), isSymlink: false }

  try {
    return { ...base, ...describe(await statTarget(path)), isSymlink: true }
  } catch {
    const modifiedAt = raw.attrs.mtime !== undefined ? raw.attrs.mtime * 1000 : null
    return { ...base, kind: 'other', isSymlink: true, size: null, modifiedAt }
  }
}
