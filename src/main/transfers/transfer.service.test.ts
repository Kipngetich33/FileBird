import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StartTransferRequest, TransferUpdate } from '../../shared/types/transfers'
import { AppError } from '../errors'
import {
  TransferCancelled,
  type RemoteFileStat,
  type SftpProvider,
  type TransferOptions,
  type UploadOptions
} from '../sftp/sftp-provider'
import { TransferService } from './transfer.service'

const CONNECTION = '5b7c1f7e-7a51-4a5f-9a43-3f1d8c2b9e10'

/** An in-memory remote side. Uploads wait until the test releases them. */
class FakeRemote implements Partial<SftpProvider> {
  readonly files = new Map<string, RemoteFileStat>([['/drop', { kind: 'directory', size: 0, modifiedAt: null, mode: 0o755 }]])
  removed: string[] = []
  /** Size the fake reports for a finished upload; null means "what was sent". */
  writtenSize: number | null = null
  uploadError: unknown = null
  private release: (() => void) | null = null
  progress: ((transferred: number, total: number) => void) | null = null

  async stat(path: string): Promise<RemoteFileStat | null> {
    return this.files.get(path) ?? null
  }

  upload(_local: string, remote: string, options: UploadOptions): Promise<void> {
    this.progress = options.onProgress
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new TransferCancelled()))
      this.release = () => {
        if (this.uploadError !== null) return reject(this.uploadError)
        this.files.set(remote, { kind: 'file', size: this.writtenSize ?? 5, modifiedAt: null, mode: 0o644 })
        resolve()
      }
    })
  }

  download(_remote: string, _local: string, _options: TransferOptions): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from)
    if (file === undefined) throw new Error('missing')
    this.files.delete(from)
    this.files.set(to, file)
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path)
    this.files.delete(path)
  }

  finishUpload(): void {
    this.release?.()
  }
}

describe('TransferService', () => {
  let dir: string
  let remote: FakeRemote
  let updates: TransferUpdate[]
  let service: TransferService

  const upload = (overrides: Partial<StartTransferRequest> = {}): StartTransferRequest => ({
    connectionId: CONNECTION,
    direction: 'upload',
    sourcePath: join(dir, 'hello.txt'),
    destinationDirectory: '/drop',
    onConflict: 'ask',
    ...overrides
  })

  const makeService = (platform: NodeJS.Platform = 'darwin'): TransferService =>
    new TransferService({
      providerFor: () => remote as unknown as SftpProvider,
      emit: (update) => updates.push(update),
      platform,
      randomSuffix: () => 'abc',
      progressIntervalMs: 0
    })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-transfer-unit-'))
    await writeFile(join(dir, 'hello.txt'), 'hello')
    remote = new FakeRemote()
    updates = []
    service = makeService()
  })

  afterEach(async () => {
    service.cancelAll()
    await service.whenIdle()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes to a hidden temporary name, then renames into place', async () => {
    const outcome = await service.start(upload())
    expect(outcome).toMatchObject({ status: 'started', transfer: { name: 'hello.txt', destinationPath: '/drop/hello.txt', totalBytes: 5 } })
    expect(remote.progress).not.toBeNull()
    remote.finishUpload()
    await service.whenIdle()

    expect(remote.files.has('/drop/hello.txt')).toBe(true)
    expect(remote.files.has('/drop/.hello.txt.fly-part-abc')).toBe(false)
    expect(updates.map((u) => u.status)).toEqual(['running', 'completed'])
    expect(updates.at(-1)).toMatchObject({ transferredBytes: 5, bytesPerSecond: 0 })
  })

  it('refuses a second start, even one that raced past the first check', async () => {
    const [first, second] = await Promise.allSettled([service.start(upload()), service.start(upload())])
    expect(first.status).toBe('fulfilled')
    expect(second.status === 'rejected' && second.reason instanceof AppError && second.reason.code).toBe('TRANSFER_BUSY')
  })

  it('treats a size mismatch as a failure and removes the temporary file', async () => {
    remote.writtenSize = 3
    await service.start(upload())
    remote.finishUpload()
    await service.whenIdle()

    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: { code: 'TRANSFER_FAILED' } })
    expect(remote.removed).toEqual(['/drop/.hello.txt.fly-part-abc'])
    expect(remote.files.has('/drop/hello.txt')).toBe(false)
  })

  it('reports an unexpected error without its details', async () => {
    remote.uploadError = new Error('socket hang up at 0xdeadbeef')
    await service.start(upload())
    remote.finishUpload()
    await service.whenIdle()
    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: { code: 'INTERNAL', message: 'The transfer failed. Please try again.' } })
  })

  it('cancels, cleans up, and ignores progress that arrives afterwards', async () => {
    const outcome = await service.start(upload())
    if (outcome.status !== 'started') throw new Error('not started')
    service.cancel('some-other-id')
    service.cancel(outcome.transfer.id)
    await service.whenIdle()
    const count = updates.length
    remote.progress?.(4, 5)

    expect(updates.at(-1)).toMatchObject({ status: 'cancelled', error: null })
    expect(updates.length).toBe(count)
    expect(remote.removed).toEqual(['/drop/.hello.txt.fly-part-abc'])
    // Idle again: a new transfer may start.
    await expect(service.start(upload())).resolves.toMatchObject({ status: 'started' })
  })

  it('asks before replacing, and numbers the copy when keeping both', async () => {
    remote.files.set('/drop/hello.txt', { kind: 'file', size: 9, modifiedAt: 1_000, mode: 0o644 })
    remote.files.set('/drop/hello (1).txt', { kind: 'file', size: 9, modifiedAt: 1_000, mode: 0o644 })

    await expect(service.start(upload())).resolves.toMatchObject({
      status: 'conflict',
      canReplace: true,
      existing: { size: 9, modifiedAt: 1_000, isDirectory: false },
      incoming: { size: 5, isDirectory: false }
    })
    expect(updates).toEqual([])

    const outcome = await service.start(upload({ onConflict: 'keep-both' }))
    expect(outcome).toMatchObject({ status: 'started', transfer: { name: 'hello (2).txt' } })
  })

  it('never offers to replace a folder', async () => {
    remote.files.set('/drop/hello.txt', { kind: 'directory', size: 0, modifiedAt: null, mode: 0o755 })
    await expect(service.start(upload({ onConflict: 'replace' }))).resolves.toMatchObject({ status: 'conflict', canReplace: false })
  })

  it('refuses a destination that is not a folder, and a source that is not a file', async () => {
    remote.files.set('/drop/file', { kind: 'file', size: 1, modifiedAt: null, mode: 0o644 })
    await expect(service.start(upload({ destinationDirectory: '/drop/file' }))).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' })
    await expect(service.start(upload({ sourcePath: dir }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses to download a name Windows cannot store', async () => {
    remote.files.set('/drop/what?.txt', { kind: 'file', size: 1, modifiedAt: null, mode: 0o644 })
    const windows = makeService('win32')
    await expect(
      windows.start({ connectionId: CONNECTION, direction: 'download', sourcePath: '/drop/what?.txt', destinationDirectory: dir, onConflict: 'ask' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
