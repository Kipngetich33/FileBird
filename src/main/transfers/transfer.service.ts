import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import type {
  FileFacts,
  StartTransferOutcome,
  StartTransferRequest,
  TransferStatus,
  TransferUpdate
} from '../../shared/types/transfers'
import { AppError, errnoOf } from '../errors'
import { createLogger } from '../logger'
import { TransferCancelled, type RemoteFileStat, type SftpProvider } from '../sftp/sftp-provider'
import { assertTransferName, firstFreeName, temporaryName } from './names'
import { createProgressReporter } from './progress'

const log = createLogger('transfers')

export interface TransferServiceOptions {
  /** Throws NOT_CONNECTED for an unknown or closed connection. */
  providerFor: (connectionId: string) => SftpProvider
  emit: (update: TransferUpdate) => void
  now?: () => number
  platform?: NodeJS.Platform
  randomSuffix?: () => string
  progressIntervalMs?: number
}

interface Running {
  update: TransferUpdate
  controller: AbortController
  done: Promise<void>
}

type FileStat = RemoteFileStat

const facts = (file: FileStat): FileFacts => ({
  size: file.kind === 'file' ? file.size : null,
  modifiedAt: file.modifiedAt,
  isDirectory: file.kind === 'directory'
})

function localError(error: unknown): unknown {
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

async function localStat(path: string): Promise<FileStat | null> {
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

const notAFile = (): AppError =>
  new AppError('INVALID_INPUT', 'Only files can be transferred for now. Folders arrive with the transfer queue.')

/**
 * Uploads and downloads (Milestone 6). The main process owns the transfer
 * (spec section 16); the renderer asks for one and receives updates.
 *
 * One transfer at a time until the queue (Milestone 7). Every transfer writes
 * to a hidden temporary name, checks the size, then renames, so a failed or
 * cancelled transfer never leaves a partial file under the real name.
 */
export class TransferService {
  private readonly options: TransferServiceOptions
  private readonly now: () => number
  private current: Running | null = null

  constructor(options: TransferServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  async start(request: StartTransferRequest): Promise<StartTransferOutcome> {
    this.assertIdle()
    const provider = this.options.providerFor(request.connectionId)
    const upload = request.direction === 'upload'
    const platform = this.options.platform ?? process.platform

    // Local paths use the platform's rules; remote paths are always POSIX.
    const destinationJoin = upload ? posix.join : join
    const destinationStat = (path: string): Promise<FileStat | null> => (upload ? provider.stat(path) : localStat(path))

    const source = upload ? await localStat(request.sourcePath) : await provider.stat(request.sourcePath)
    if (source === null) throw new AppError('NOT_FOUND', 'The file no longer exists.')
    if (source.kind !== 'file') throw notAFile()

    const name = assertTransferName(
      upload ? basename(request.sourcePath) : posix.basename(request.sourcePath),
      upload ? 'linux' : platform
    )

    const folder = await destinationStat(request.destinationDirectory)
    if (folder === null) throw new AppError('NOT_FOUND', 'The destination folder no longer exists.')
    if (folder.kind !== 'directory') throw new AppError('NOT_A_DIRECTORY', 'The destination is not a folder.')

    let finalName = name
    const existing = await destinationStat(destinationJoin(request.destinationDirectory, name))
    if (existing !== null) {
      const canReplace = existing.kind === 'file'
      if (request.onConflict === 'ask' || (request.onConflict === 'replace' && !canReplace)) {
        return { status: 'conflict', name, existing: facts(existing), incoming: facts(source), canReplace }
      }
      if (request.onConflict === 'keep-both') {
        finalName = await firstFreeName(name, async (candidate) =>
          (await destinationStat(destinationJoin(request.destinationDirectory, candidate))) !== null
        )
      }
    }

    // The checks above awaited; make sure nothing else started meanwhile.
    this.assertIdle()

    const update: TransferUpdate = {
      id: randomUUID(),
      connectionId: request.connectionId,
      direction: request.direction,
      name: finalName,
      sourcePath: request.sourcePath,
      destinationPath: destinationJoin(request.destinationDirectory, finalName),
      destinationDirectory: request.destinationDirectory,
      transferredBytes: 0,
      totalBytes: source.size,
      bytesPerSecond: 0,
      status: 'running',
      error: null,
      startedAt: this.now(),
      finishedAt: null
    }
    const running: Running = { update, controller: new AbortController(), done: Promise.resolve() }
    this.current = running
    this.options.emit({ ...update })
    running.done = this.run(running, provider, source)
    log.info('Transfer started', { id: update.id, direction: update.direction, bytes: update.totalBytes })
    return { status: 'started', transfer: { ...update } }
  }

  /** Cancelling an unknown or finished transfer is not an error. */
  cancel(id: string): void {
    if (this.current?.update.id === id) this.current.controller.abort()
  }

  cancelAll(): void {
    this.current?.controller.abort()
  }

  /** Resolves when no transfer is running (for tests and shutdown). */
  async whenIdle(): Promise<void> {
    await this.current?.done
  }

  private assertIdle(): void {
    if (this.current !== null) {
      throw new AppError('TRANSFER_BUSY', 'Another transfer is still running. Wait for it to finish, or cancel it.')
    }
  }

  private async run(running: Running, provider: SftpProvider, source: FileStat): Promise<void> {
    const { update, controller } = running
    const upload = update.direction === 'upload'
    const suffix = this.options.randomSuffix?.() ?? randomBytes(6).toString('hex')
    const destinationJoin = upload ? posix.join : join
    const temporaryPath = destinationJoin(update.destinationDirectory, temporaryName(update.name, suffix))

    const reporter = createProgressReporter({
      now: this.now,
      intervalMs: this.options.progressIntervalMs,
      emit: (snapshot) => {
        if (this.current !== running) return
        Object.assign(update, { transferredBytes: snapshot.transferred, bytesPerSecond: snapshot.bytesPerSecond })
        this.options.emit({ ...update })
      }
    })

    try {
      if (upload) {
        await provider.upload(update.sourcePath, temporaryPath, {
          signal: controller.signal,
          onProgress: reporter.update,
          mode: source.mode ?? 0o644,
          modifiedAt: source.modifiedAt
        })
        const written = await provider.stat(temporaryPath)
        if (written?.size !== source.size) throw incomplete()
        if (controller.signal.aborted) throw new TransferCancelled()
        await provider.rename(temporaryPath, update.destinationPath)
      } else {
        await provider.download(update.sourcePath, temporaryPath, { signal: controller.signal, onProgress: reporter.update })
        try {
          const written = await stat(temporaryPath)
          if (written.size !== source.size) throw incomplete()
          if (source.mode !== null) await chmod(temporaryPath, source.mode & 0o777)
          if (source.modifiedAt !== null) await utimes(temporaryPath, new Date(), new Date(source.modifiedAt))
          if (controller.signal.aborted) throw new TransferCancelled()
          await rename(temporaryPath, update.destinationPath)
        } catch (error) {
          throw localError(error)
        }
      }
      this.finish(running, 'completed', null, source.size)
    } catch (error) {
      await this.removeQuietly(provider, temporaryPath, upload)
      if (error instanceof TransferCancelled || controller.signal.aborted) {
        this.finish(running, 'cancelled', null)
      } else if (error instanceof AppError) {
        this.finish(running, 'failed', error.toPayload())
      } else {
        log.error('Transfer failed', { id: update.id, error: error instanceof Error ? error.stack : String(error) })
        this.finish(running, 'failed', { code: 'INTERNAL', message: 'The transfer failed. Please try again.' })
      }
    }
  }

  private finish(running: Running, status: TransferStatus, error: TransferUpdate['error'], transferred?: number): void {
    const { update } = running
    Object.assign(update, {
      status,
      error,
      finishedAt: this.now(),
      bytesPerSecond: 0,
      ...(transferred === undefined ? {} : { transferredBytes: transferred })
    })
    if (this.current === running) this.current = null
    log.info('Transfer finished', { id: update.id, status, code: error?.code })
    this.options.emit({ ...update })
  }

  /** Best effort: a connection that is already gone can't remove its remote partial file. */
  private async removeQuietly(provider: SftpProvider, path: string, remote: boolean): Promise<void> {
    try {
      if (remote) await provider.remove(path)
      else await rm(path, { force: true })
    } catch (error) {
      log.warn('Could not remove a partial transfer file', { remote, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

const incomplete = (): AppError =>
  new AppError('TRANSFER_FAILED', 'The transferred file is incomplete. It may have changed while being copied.')
