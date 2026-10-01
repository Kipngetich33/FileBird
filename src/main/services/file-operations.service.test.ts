import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../errors'
import type { SftpProvider } from '../sftp/sftp-provider'
import { FileOperationsService } from './file-operations.service'

const LOCAL = { side: 'local' } as const
const isRoot = process.getuid?.() === 0

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : String(error)
  }
  return 'did not throw'
}

describe('FileOperationsService (local)', () => {
  let dir: string
  let home: string
  let trashed: string[]
  let trashFails: boolean
  let service: FileOperationsService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-file-ops-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'docs'), { recursive: true })
    trashed = []
    trashFails = false
    service = new FileOperationsService({
      localHome: home,
      platform: 'darwin',
      trash: async (path) => {
        if (trashFails) throw new Error('no trash here')
        trashed.push(path)
        await rm(path, { recursive: true, force: true })
      },
      providerFor: () => {
        throw new Error('remote not used')
      },
      remoteHomeOf: () => null
    })
  })

  afterEach(async () => {
    await chmod(join(home, 'locked'), 0o755).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a folder, and refuses a taken or invalid name', async () => {
    expect(await service.createFolder(LOCAL, join(home, 'docs'), 'new folder')).toBe(join(home, 'docs', 'new folder'))
    expect((await stat(join(home, 'docs', 'new folder'))).isDirectory()).toBe(true)
    expect(await codeOf(service.createFolder(LOCAL, join(home, 'docs'), 'new folder'))).toBe('ALREADY_EXISTS')
    expect(await codeOf(service.createFolder(LOCAL, join(home, 'docs'), 'a/b'))).toBe('INVALID_INPUT')
    expect(await codeOf(service.createFolder(LOCAL, join(home, 'gone'), 'x'))).toBe('NOT_FOUND')
  })

  it('renames in place and never replaces an existing item', async () => {
    await writeFile(join(home, 'docs', 'a.txt'), 'a')
    await writeFile(join(home, 'docs', 'b.txt'), 'b')
    expect(await service.rename(LOCAL, join(home, 'docs', 'a.txt'), 'c.txt')).toBe(join(home, 'docs', 'c.txt'))
    expect(await codeOf(service.rename(LOCAL, join(home, 'docs', 'c.txt'), 'b.txt'))).toBe('ALREADY_EXISTS')
    expect((await readdir(join(home, 'docs'))).sort()).toEqual(['b.txt', 'c.txt'])
    expect(await codeOf(service.rename(LOCAL, join(home, 'docs', 'c.txt'), '..'))).toBe('INVALID_INPUT')
  })

  it('allows a case-only rename of the same file', async () => {
    await writeFile(join(home, 'docs', 'readme.md'), 'x')
    expect(await service.rename(LOCAL, join(home, 'docs', 'readme.md'), 'README.md')).toBe(join(home, 'docs', 'README.md'))
    expect(await readdir(join(home, 'docs'))).toEqual(['README.md'])
  })

  it('moves the selection to the trash, links included, reporting what could not be', async () => {
    await writeFile(join(home, 'docs', 'a.txt'), 'a')
    await mkdir(join(home, 'docs', 'folder', 'inner'), { recursive: true })
    await symlink(join(home, 'docs', 'folder'), join(home, 'docs', 'link'))
    const outcome = await service.delete(LOCAL, [join(home, 'docs', 'a.txt'), join(home, 'docs', 'folder'), join(home, 'docs', 'gone.txt'), join(home, 'docs', 'link')])

    expect(outcome.deleted).toBe(3)
    expect(outcome.failures).toEqual([{ name: 'gone.txt', path: join(home, 'docs', 'gone.txt'), error: { code: 'NOT_FOUND', message: 'It no longer exists.' } }])
    expect(trashed).toEqual([join(home, 'docs', 'a.txt'), join(home, 'docs', 'folder'), join(home, 'docs', 'link')])
  })

  it('never falls back to a permanent delete when the trash is unavailable', async () => {
    await writeFile(join(home, 'docs', 'keep.txt'), 'k')
    trashFails = true
    const outcome = await service.delete(LOCAL, [join(home, 'docs', 'keep.txt')])
    expect(outcome).toMatchObject({ deleted: 0, failures: [{ error: { code: 'TRASH_UNAVAILABLE' } }] })
    expect(await readdir(join(home, 'docs'))).toEqual(['keep.txt'])
  })

  it('refuses to delete or rename the home folder or anything containing it, before touching anything', async () => {
    await writeFile(join(home, 'docs', 'a.txt'), 'a')
    expect(await codeOf(service.delete(LOCAL, [join(home, 'docs', 'a.txt'), home]))).toBe('NOT_ALLOWED')
    expect(await codeOf(service.delete(LOCAL, [dir]))).toBe('NOT_ALLOWED')
    expect(await codeOf(service.delete(LOCAL, ['/']))).toBe('NOT_ALLOWED')
    expect(await codeOf(service.rename(LOCAL, home, 'elsewhere'))).toBe('NOT_ALLOWED')
    expect(trashed).toEqual([])
  })

  it.skipIf(isRoot)('rewords permission errors for the operation', async () => {
    await mkdir(join(home, 'locked'))
    await writeFile(join(home, 'locked', 'x.txt'), 'x')
    await chmod(join(home, 'locked'), 0o555)
    await expect(service.createFolder(LOCAL, join(home, 'locked'), 'new')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: "You don't have permission to create a folder here."
    })
    await expect(service.rename(LOCAL, join(home, 'locked', 'x.txt'), 'y.txt')).rejects.toMatchObject({
      message: "You don't have permission to rename this."
    })
  })

  it('stops deleting on the remote side once the connection is gone', async () => {
    let removals = 0
    const provider = {
      lstat: async () => ({ kind: 'file', isSymlink: false }),
      remove: async () => {
        removals += 1
        throw new AppError('CONNECTION_LOST', 'lost')
      }
    } as unknown as SftpProvider
    const remote = new FileOperationsService({
      localHome: home,
      platform: 'darwin',
      trash: async () => undefined,
      providerFor: () => provider,
      remoteHomeOf: () => '/home/me'
    })
    const outcome = await remote.delete({ side: 'remote', connectionId: 'c' }, ['/srv/a', '/srv/b', '/srv/c'])
    expect(outcome).toMatchObject({ deleted: 0, failures: [{ name: 'a', error: { code: 'CONNECTION_LOST' } }] })
    expect(removals).toBe(1)
  })
})

describe('FileOperationsService (move, local)', () => {
  let dir: string
  let home: string
  let service: FileOperationsService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-move-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'photos'), { recursive: true })
    await writeFile(join(home, 'note.txt'), 'hello')
    service = new FileOperationsService({
      localHome: home,
      platform: 'darwin',
      trash: async () => undefined,
      providerFor: () => {
        throw new Error('not used')
      },
      remoteHomeOf: () => null
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('moves an item into a folder, leaving nothing behind', async () => {
    const outcome = await service.move(LOCAL, [join(home, 'note.txt')], join(home, 'photos'))
    expect(outcome).toEqual({ moved: 1, alreadyThere: 0, failures: [] })
    expect(await readdir(join(home, 'photos'))).toEqual(['note.txt'])
    expect(await readdir(home)).toEqual(['photos'])
  })

  it('never overwrites: a name already in that folder fails, and both copies stay', async () => {
    await writeFile(join(home, 'photos', 'note.txt'), 'the one already there')
    const outcome = await service.move(LOCAL, [join(home, 'note.txt')], join(home, 'photos'))
    expect(outcome.moved).toBe(0)
    expect(outcome.failures[0]?.error.code).toBe('ALREADY_EXISTS')
    expect(await readFile(join(home, 'photos', 'note.txt'), 'utf8')).toBe('the one already there')
    expect(await readFile(join(home, 'note.txt'), 'utf8')).toBe('hello')
  })

  it('does nothing when an item is already in that folder', async () => {
    const outcome = await service.move(LOCAL, [join(home, 'note.txt')], home)
    expect(outcome).toEqual({ moved: 0, alreadyThere: 1, failures: [] })
    expect(await readFile(join(home, 'note.txt'), 'utf8')).toBe('hello')
  })

  it('refuses to move a folder inside itself', async () => {
    await mkdir(join(home, 'photos', 'holiday'))
    const outcome = await service.move(LOCAL, [join(home, 'photos')], join(home, 'photos', 'holiday'))
    expect(outcome.moved).toBe(0)
    expect(outcome.failures[0]?.error.code).toBe('NOT_ALLOWED')
    expect(await stat(join(home, 'photos', 'holiday')).then(() => true)).toBe(true)
  })

  it('refuses to move the home folder itself', async () => {
    expect(await codeOf(service.move(LOCAL, [home], join(home, 'photos')))).toBe('NOT_ALLOWED')
  })

  it('refuses a destination that is not a folder', async () => {
    expect(await codeOf(service.move(LOCAL, [join(home, 'photos')], join(home, 'note.txt')))).toBe('NOT_A_DIRECTORY')
  })

  it('moves what it can and reports what it could not, in one go', async () => {
    await writeFile(join(home, 'a.txt'), 'a')
    await writeFile(join(home, 'photos', 'a.txt'), 'already here')
    await writeFile(join(home, 'b.txt'), 'b')
    const outcome = await service.move(LOCAL, [join(home, 'a.txt'), join(home, 'b.txt')], join(home, 'photos'))
    expect(outcome.moved).toBe(1)
    expect(outcome.failures.map((failure) => failure.name)).toEqual(['a.txt'])
    expect((await readdir(join(home, 'photos'))).sort()).toEqual(['a.txt', 'b.txt'])
  })
})
