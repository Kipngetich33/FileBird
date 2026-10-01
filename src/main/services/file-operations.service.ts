import { lstat, mkdir, rename } from 'node:fs/promises'
import { basename, dirname, join, posix, sep } from 'node:path'
import { nameProblem } from '../../shared/names'
import type { DeleteFailure, DeleteOutcome, FileTarget, MoveOutcome } from '../../shared/types/file-operations'
import { AppError, errnoOf } from '../errors'
import { createLogger } from '../logger'
import type { SftpProvider } from '../sftp/sftp-provider'
import { mapLimit } from '../utils/map-limit'
import { isProtectedPath } from './protected-paths'
import { APP_NAME } from '../../shared/constants/app'

const log = createLogger('file-operations')

/** Files removed at once inside one remote folder. */
const REMOVE_CONCURRENCY = 8

export interface FileOperationsOptions {
  /** Where the local pane starts; it and its ancestors are never deleted or renamed. */
  localHome: string
  platform: NodeJS.Platform
  /** Moves a local item to the Trash / Recycle Bin. */
  trash: (path: string) => Promise<void>
  /** Throws NOT_CONNECTED for a closed connection. */
  providerFor: (connectionId: string) => SftpProvider
  remoteHomeOf: (connectionId: string) => string | null
}

type Verb = 'create' | 'rename' | 'delete' | 'move'

const notAllowed = (): AppError =>
  new AppError('NOT_ALLOWED', `${APP_NAME} won't delete or rename your home folder, or a folder that contains it.`)

/** Operation-specific wording for errors whose generic message is about browsing. */
function reword(error: unknown, verb: Verb): unknown {
  if (!(error instanceof AppError)) return error
  switch (error.code) {
    case 'PERMISSION_DENIED':
      return new AppError(
        'PERMISSION_DENIED',
        verb === 'create'
          ? "You don't have permission to create a folder here."
          : verb === 'rename'
            ? "You don't have permission to rename this."
            : verb === 'move'
              ? "You don't have permission to move this."
              : "You don't have permission to delete this."
      )
    case 'NOT_FOUND':
      return new AppError('NOT_FOUND', verb === 'create' ? 'This folder no longer exists.' : 'It no longer exists.')
    default:
      return error
  }
}

function localError(error: unknown, verb: Verb): unknown {
  switch (errnoOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return reword(new AppError('NOT_FOUND', ''), verb)
    case 'EACCES':
    case 'EPERM':
      return reword(new AppError('PERMISSION_DENIED', ''), verb)
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new AppError('ALREADY_EXISTS', 'An item with this name already exists here.')
    default:
      return error
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false
    throw error
  }
}

/**
 * Create folder, rename and delete on either side (Milestone 8). Every input
 * came from the renderer and is checked again here: names against the shared
 * rules, and deletes and renames against the protected paths.
 */
export class FileOperationsService {
  private readonly options: FileOperationsOptions

  constructor(options: FileOperationsOptions) {
    this.options = options
  }

  async createFolder(target: FileTarget, parent: string, name: string): Promise<string> {
    this.assertName(target, name)
    if (target.side === 'local') {
      const path = join(parent, name)
      try {
        await mkdir(path)
      } catch (error) {
        throw localError(error, 'create')
      }
      return path
    }

    const provider = this.options.providerFor(target.connectionId)
    const path = posix.join(parent, name)
    try {
      if ((await provider.lstat(path)) !== null || (await provider.mkdir(path)) === 'exists') {
        throw new AppError('ALREADY_EXISTS', 'An item with this name already exists here.')
      }
    } catch (error) {
      throw reword(error, 'create')
    }
    return path
  }

  async rename(target: FileTarget, path: string, newName: string): Promise<string> {
    this.assertName(target, newName)
    this.assertUnprotected(target, path)

    if (target.side === 'local') {
      if (basename(path) === newName) return path
      const destination = join(dirname(path), newName)
      try {
        const source = await lstat(path)
        // A case-only rename finds the same file under the new name on a case-insensitive disk.
        if (await exists(destination)) {
          const other = await lstat(destination)
          if (other.ino !== source.ino || other.dev !== source.dev) {
            throw new AppError('ALREADY_EXISTS', 'An item with this name already exists here.')
          }
        }
        await rename(path, destination)
      } catch (error) {
        throw error instanceof AppError ? error : localError(error, 'rename')
      }
      return destination
    }

    if (posix.basename(path) === newName) return path
    const provider = this.options.providerFor(target.connectionId)
    const destination = posix.join(posix.dirname(path), newName)
    try {
      await provider.renameNoReplace(path, destination)
    } catch (error) {
      throw reword(error, 'rename')
    }
    return destination
  }

  /**
   * Moves items into a folder on the same side (Milestone 12): dragging a file
   * onto a folder in the pane it is already in.
   *
   * A move is a rename, so it never copies and never overwrites: a name already
   * in the destination fails that item and leaves both copies alone. Items
   * already in that folder are counted apart, because dropping something where
   * it already is should do nothing rather than report an error.
   */
  async move(target: FileTarget, paths: string[], destination: string): Promise<MoveOutcome> {
    for (const path of paths) this.assertUnprotected(target, path)
    const provider = target.side === 'remote' ? this.options.providerFor(target.connectionId) : null
    const parentOf = (path: string): string => (target.side === 'local' ? dirname(path) : posix.dirname(path))
    const nameOf = (path: string): string => (target.side === 'local' ? basename(path) : posix.basename(path))
    const into = (path: string): string => (target.side === 'local' ? join(destination, nameOf(path)) : posix.join(destination, nameOf(path)))

    if (provider === null) {
      const folder = await lstat(destination).catch((error: unknown) => Promise.reject(localError(error, 'move')))
      if (!folder.isDirectory()) throw new AppError('NOT_A_DIRECTORY', 'That is not a folder.')
    } else if ((await provider.stat(destination))?.kind !== 'directory') {
      throw new AppError('NOT_A_DIRECTORY', 'That is not a folder.')
    }

    let moved = 0
    let alreadyThere = 0
    const failures: DeleteFailure[] = []
    for (const path of paths) {
      const name = nameOf(path)
      try {
        if (parentOf(path) === destination) {
          alreadyThere += 1
          continue
        }
        // A folder cannot be moved inside itself: the destination would travel with it.
        if (destination === path || destination.startsWith(`${path}${target.side === 'local' ? sep : '/'}`)) {
          throw new AppError('NOT_ALLOWED', `"${name}" can't be moved inside itself.`)
        }
        if (provider === null) await this.moveLocal(path, into(path))
        else await provider.renameNoReplace(path, into(path))
        moved += 1
      } catch (cause) {
        const error = reword(cause, 'move')
        if (error instanceof AppError) {
          failures.push({ name, path, error: error.toPayload() })
        } else {
          log.error('Move failed', { error: error instanceof Error ? error.stack : String(error) })
          failures.push({ name, path, error: { code: 'INTERNAL', message: 'Something went wrong while moving this.' } })
        }
        if (error instanceof AppError && (error.code === 'CONNECTION_LOST' || error.code === 'NOT_CONNECTED')) break
      }
    }
    log.info('Moved', { side: target.side, requested: paths.length, moved, alreadyThere, failed: failures.length })
    return { moved, alreadyThere, failures }
  }

  private async moveLocal(path: string, destination: string): Promise<void> {
    if (await exists(destination)) throw new AppError('ALREADY_EXISTS', 'An item with this name is already in that folder.')
    try {
      await rename(path, destination)
    } catch (error) {
      // Another disk can't be renamed onto; that needs a copy, which this isn't.
      if (errnoOf(error) === 'EXDEV') {
        throw new AppError('NOT_ALLOWED', "That folder is on another disk. Moving between disks isn't supported yet; copy it through the other pane instead.")
      }
      throw localError(error, 'move')
    }
  }

  /** Validates every path first, then deletes each item; one failure doesn't stop the rest. */
  async delete(target: FileTarget, paths: string[]): Promise<DeleteOutcome> {
    for (const path of paths) this.assertUnprotected(target, path)
    const provider = target.side === 'remote' ? this.options.providerFor(target.connectionId) : null

    let deleted = 0
    const failures: DeleteFailure[] = []
    for (const path of paths) {
      const name = target.side === 'local' ? basename(path) : posix.basename(path)
      try {
        if (provider === null) await this.trashLocal(path)
        else await this.deleteRemote(provider, path)
        deleted += 1
      } catch (cause) {
        const error = reword(cause, 'delete')
        if (error instanceof AppError) {
          failures.push({ name, path, error: error.toPayload() })
        } else {
          log.error('Delete failed', { error: error instanceof Error ? error.stack : String(error) })
          failures.push({ name, path, error: { code: 'INTERNAL', message: 'Something went wrong while deleting this.' } })
        }
        // A closed connection fails every remaining item the same way; stop asking it.
        if (error instanceof AppError && (error.code === 'CONNECTION_LOST' || error.code === 'NOT_CONNECTED')) break
      }
    }
    log.info('Deleted', { side: target.side, requested: paths.length, deleted, failed: failures.length })
    return { deleted, failures }
  }

  private async trashLocal(path: string): Promise<void> {
    if (!(await exists(path).catch((error: unknown) => Promise.reject(localError(error, 'delete'))))) {
      throw new AppError('NOT_FOUND', '')
    }
    try {
      await this.options.trash(path)
    } catch (error) {
      log.warn('Could not move to the Trash', { error: error instanceof Error ? error.message : String(error) })
      const place = this.options.platform === 'win32' ? 'Recycle Bin' : 'Trash'
      throw new AppError('TRASH_UNAVAILABLE', `This couldn't be moved to the ${place}. Nothing was deleted.`)
    }
  }

  /** Links are removed as links; only real folders are emptied, deepest first. */
  private async deleteRemote(provider: SftpProvider, path: string): Promise<void> {
    const item = await provider.lstat(path)
    if (item === null) throw new AppError('NOT_FOUND', '')
    if (item.isSymlink || item.kind !== 'directory') {
      await provider.remove(path)
      return
    }
    const entries = await provider.list(path)
    const folders = entries.filter((entry) => entry.kind === 'directory' && !entry.isSymlink)
    const others = entries.filter((entry) => !(entry.kind === 'directory' && !entry.isSymlink))
    await mapLimit(others, REMOVE_CONCURRENCY, (entry) => provider.remove(entry.path))
    for (const folder of folders) await this.deleteRemote(provider, folder.path)
    await provider.removeDirectory(path)
  }

  private assertName(target: FileTarget, name: string): void {
    const problem = nameProblem(name, target.side === 'local' ? this.options.platform : 'linux')
    if (problem !== null) throw new AppError('INVALID_INPUT', problem)
  }

  private assertUnprotected(target: FileTarget, path: string): void {
    if (target.side === 'local') {
      if (isProtectedPath(path, this.options.localHome, this.options.platform === 'win32' ? 'win32' : 'posix')) throw notAllowed()
      return
    }
    const home = this.options.remoteHomeOf(target.connectionId)
    // Without a live connection there is nothing to delete; the provider reports that.
    if (home !== null && isProtectedPath(path, home, 'posix')) throw notAllowed()
    if (home === null && path === '/') throw notAllowed()
  }
}
