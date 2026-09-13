import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry } from '../../shared/types/files'
import { AppError } from '../errors'
import { listDirectory, readEntry } from './local-files.service'

// Root ignores permission bits, so the locked-folder case cannot fail as root.
const isRoot = process.getuid?.() === 0

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fly-local-files-'))
  await mkdir(join(root, 'alpha'))
  await writeFile(join(root, 'file2.txt'), 'hello')
  await writeFile(join(root, '.hidden'), '')
  await symlink(join(root, 'alpha'), join(root, 'link-to-alpha'))
  await symlink(join(root, 'missing'), join(root, 'broken-link'))
  await mkdir(join(root, 'locked'))
  await chmod(join(root, 'locked'), 0o000)
})

afterAll(async () => {
  await chmod(join(root, 'locked'), 0o755)
  await rm(root, { recursive: true, force: true })
})

async function entryNamed(name: string): Promise<FileEntry> {
  const listing = await listDirectory(root)
  const entry = listing.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`${name} missing from listing`)
  return entry
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

describe('listDirectory', () => {
  it('lists every entry with an absolute path and the parent folder', async () => {
    const listing = await listDirectory(root)
    expect(listing.path).toBe(root)
    expect(listing.parentPath).toBe(dirname(root))
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(
      ['.hidden', 'alpha', 'broken-link', 'file2.txt', 'link-to-alpha', 'locked'].sort()
    )
    for (const entry of listing.entries) expect(entry.path).toBe(join(root, entry.name))
  })

  it('describes a file', async () => {
    expect(await entryNamed('file2.txt')).toMatchObject({
      kind: 'file',
      size: 5,
      isSymlink: false,
      isHidden: false,
      modifiedAt: expect.any(Number)
    })
  })

  it('describes a folder without a size', async () => {
    expect(await entryNamed('alpha')).toMatchObject({ kind: 'directory', size: null, isSymlink: false })
  })

  it('marks dotfiles hidden', async () => {
    expect((await entryNamed('.hidden')).isHidden).toBe(true)
  })

  it('follows a symlink so a linked folder can be opened', async () => {
    expect(await entryNamed('link-to-alpha')).toMatchObject({ kind: 'directory', isSymlink: true })
  })

  it('reports a broken symlink as other, without failing the listing', async () => {
    expect(await entryNamed('broken-link')).toMatchObject({ kind: 'other', isSymlink: true, size: null })
  })

  it('has no parent at the filesystem root', async () => {
    expect((await listDirectory(parse(root).root)).parentPath).toBeNull()
  })

  it('reports a missing folder as NOT_FOUND', async () => {
    expect(await codeOf(listDirectory(join(root, 'nope')))).toBe('NOT_FOUND')
  })

  it('reports a file as NOT_A_DIRECTORY', async () => {
    expect(await codeOf(listDirectory(join(root, 'file2.txt')))).toBe('NOT_A_DIRECTORY')
  })

  it.skipIf(isRoot)('reports an unreadable folder as PERMISSION_DENIED', async () => {
    expect(await codeOf(listDirectory(join(root, 'locked')))).toBe('PERMISSION_DENIED')
  })
})

describe('readEntry', () => {
  it('never throws for an entry that vanished after the directory was read', async () => {
    expect(await readEntry(root, 'gone-already')).toMatchObject({
      kind: 'other',
      size: null,
      modifiedAt: null
    })
  })
})
