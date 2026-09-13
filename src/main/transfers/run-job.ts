import { chmod, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import type { TransferDirection } from '../../shared/types/transfers'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import { TransferCancelled, type SftpProvider } from '../sftp/sftp-provider'
import { temporaryName } from './names'
import { localError, localStat, type FileStat } from './sides'

const log = createLogger('transfers')

export interface RunJobOptions {
  direction: TransferDirection
  sourcePath: string
  destinationPath: string
  /** The user chose Replace for this file; otherwise an existing destination fails the job. */
  replace: boolean
  provider: SftpProvider
  signal: AbortSignal
  /** The source's size as it is now, which may differ from when the job was queued. */
  onStart: (totalBytes: number) => void
  onProgress: (transferred: number, total: number) => void
  suffix: string
  /** A temporary file that couldn't be removed (the connection was gone); remove it before retrying. */
  onLeftover?: (path: string) => void
}

const incomplete = (): AppError =>
  new AppError('TRANSFER_FAILED', 'The transferred file is incomplete. It may have changed while being copied.')

function checkDestination(existing: FileStat | null, replace: boolean, upload: boolean): void {
  if (existing === null) return
  const where = upload ? ' on the server' : ''
  if (existing.kind !== 'file') {
    throw new AppError('ALREADY_EXISTS', `A folder with this name now exists at the destination${where}.`)
  }
  if (!replace) throw new AppError('ALREADY_EXISTS', `A file with this name now exists at the destination${where}.`)
}

function checkSource(source: FileStat | null): FileStat {
  if (source === null) throw new AppError('NOT_FOUND', 'The file no longer exists.')
  if (source.kind !== 'file') throw new AppError('INVALID_INPUT', 'This is no longer a file.')
  return source
}

/**
 * One file, written safely (Milestone 6 plan D4): a hidden temporary name
 * beside the destination, a size check, then a rename. Whatever goes wrong, the
 * temporary file is removed and the error is rethrown for the queue to report.
 */
export async function runTransferJob(options: RunJobOptions): Promise<void> {
  const { provider, signal, sourcePath, destinationPath } = options
  const upload = options.direction === 'upload'

  const source = checkSource(upload ? await localStat(sourcePath) : await provider.stat(sourcePath))
  options.onStart(source.size)
  checkDestination(upload ? await provider.stat(destinationPath) : await localStat(destinationPath), options.replace, upload)
  if (signal.aborted) throw new TransferCancelled()

  const temporaryPath = upload
    ? posix.join(posix.dirname(destinationPath), temporaryName(posix.basename(destinationPath), options.suffix))
    : join(dirname(destinationPath), temporaryName(basename(destinationPath), options.suffix))

  try {
    if (upload) {
      await provider.upload(sourcePath, temporaryPath, {
        signal,
        onProgress: options.onProgress,
        mode: source.mode ?? 0o644,
        modifiedAt: source.modifiedAt
      })
      const written = await provider.stat(temporaryPath)
      if (written?.size !== source.size) throw incomplete()
      if (signal.aborted) throw new TransferCancelled()
      await provider.rename(temporaryPath, destinationPath)
    } else {
      await provider.download(sourcePath, temporaryPath, { signal, onProgress: options.onProgress })
      try {
        const written = await stat(temporaryPath)
        if (written.size !== source.size) throw incomplete()
        if (source.mode !== null) await chmod(temporaryPath, source.mode & 0o777)
        if (source.modifiedAt !== null) await utimes(temporaryPath, new Date(), new Date(source.modifiedAt))
        if (signal.aborted) throw new TransferCancelled()
        await rename(temporaryPath, destinationPath)
      } catch (error) {
        throw localError(error)
      }
    }
  } catch (error) {
    if (!(await removeQuietly(provider, temporaryPath, upload))) options.onLeftover?.(temporaryPath)
    throw error
  }
}

/**
 * Best effort; true when the file is gone. A connection that is already gone
 * can't remove its remote partial file, so the caller keeps it for later.
 */
export async function removeQuietly(provider: SftpProvider, path: string, remote: boolean): Promise<boolean> {
  try {
    if (remote) await provider.remove(path)
    else await rm(path, { force: true })
    return true
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return true
    log.warn('Could not remove a partial transfer file', { remote, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
