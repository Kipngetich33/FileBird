import { mkdir, stat } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import type { FileKind } from '../../shared/types/files'
import { AppError, errnoOf } from '../errors'
import { listDirectory } from '../services/local-files.service'
import type { RemoteFileStat, SftpProvider } from '../sftp/sftp-provider'

export type FileStat = RemoteFileStat

export interface SideEntry {
  name: string
  path: string
  /** For a symlink, the target's kind; a broken link is 'other'. */
  kind: FileKind
  isSymlink: boolean
  size: number | null
  modifiedAt: number | null
}

/**
 * One end of a transfer, local or remote, so planning a request doesn't care
 * which way it goes. Remote paths are POSIX; local paths use the platform's rules.
 */
export interface FileSide {
  readonly remote: boolean
  join(directory: string, name: string): string
  basename(path: string): string
  /** Follows symlinks. Null when nothing is there. */
  stat(path: string): Promise<FileStat | null>
  list(path: string): Promise<SideEntry[]>
  /** 'exists' when a folder is already there; a file of that name is ALREADY_EXISTS. */
  mkdir(path: string): Promise<'created' | 'exists'>
}

export function localError(error: unknown): unknown {
  switch (errnoOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new AppError('NOT_FOUND', 'The file or folder no longer exists.')
    case 'EACCES':
    case 'EPERM':
      return new AppError('PERMISSION_DENIED', "You don't have permission to use this file or folder.")
    case 'ENOSPC':
      return new AppError('DISK_FULL', "There isn't enough space on this computer for this file.")
    default:
      return error
  }
}

export async function localStat(path: string): Promise<FileStat | null> {
  try {
    const info = await stat(path)
    return {
      kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      size: info.size,
      modifiedAt: info.mtimeMs,
      mode: info.mode & 0o7777
    }
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw localError(error)
  }
}

export const localSide: FileSide = {
  remote: false,
  join,
  basename,
  stat: localStat,
  async list(path) {
    return (await listDirectory(path)).entries
  },
  async mkdir(path) {
    try {
      await mkdir(path)
      return 'created'
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw localError(error)
      const existing = await localStat(path)
      if (existing?.kind === 'directory') return 'exists'
      throw new AppError('ALREADY_EXISTS', 'A file with this name already exists on this computer.')
    }
  }
}

export function remoteSide(provider: SftpProvider): FileSide {
  return {
    remote: true,
    join: posix.join,
    basename: posix.basename,
    stat: (path) => provider.stat(path),
    list: (path) => provider.list(path),
    mkdir: (path) => provider.mkdir(path)
  }
}
