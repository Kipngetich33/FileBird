import { describe, expect, it } from 'vitest'
import { MemorySide } from '../../../test/support/memory-side'
import { AppError } from '../errors'
import { planTransfer, type PlanOptions } from './plan'

const plan = (source: MemorySide, destination: MemorySide, overrides: Partial<PlanOptions> = {}) =>
  planTransfer({
    source,
    destination,
    sourcePaths: ['/src/a.txt'],
    destinationDirectory: '/dest',
    onConflict: 'ask',
    destinationPlatform: 'linux',
    ...overrides
  })

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : String(error)
  }
  return 'did not throw'
}

describe('planTransfer', () => {
  it('plans a single file into the destination folder', async () => {
    const result = await plan(new MemorySide(false, { '/src/a.txt': 5 }), new MemorySide(true, { '/dest': 'dir' }))
    expect(result).toEqual({
      status: 'ready',
      folders: [],
      skipped: [],
      files: [
        {
          sourcePath: '/src/a.txt',
          destinationPath: '/dest/a.txt',
          destinationDirectory: '/dest',
          name: 'a.txt',
          relativePath: 'a.txt',
          size: 5,
          replace: false
        }
      ]
    })
  })

  it('walks folders, creating parents before children and empty folders too', async () => {
    const source = new MemorySide(false, {
      '/src/photos/2024/b.jpg': 2,
      '/src/photos/a.jpg': 1,
      '/src/photos/empty': 'dir'
    })
    const destination = new MemorySide(true, { '/dest': 'dir' })
    const result = await plan(source, destination, { sourcePaths: ['/src/photos'] })
    if (result.status !== 'ready') throw new Error('not ready')

    expect(result.files.map((file) => [file.relativePath, file.destinationPath, file.destinationDirectory])).toEqual([
      ['photos/2024/b.jpg', '/dest/photos/2024/b.jpg', '/dest/photos/2024'],
      ['photos/a.jpg', '/dest/photos/a.jpg', '/dest/photos']
    ])
    expect(destination.created).toEqual(['/dest/photos', '/dest/photos/2024', '/dest/photos/empty'])
  })

  it('returns conflicts for ask, and writes nothing', async () => {
    const source = new MemorySide(false, { '/src/a.txt': 5, '/src/photos/x.jpg': 1, '/src/new.txt': 1 })
    const destination = new MemorySide(true, { '/dest/a.txt': 9, '/dest/photos': 'dir' })
    const result = await plan(source, destination, { sourcePaths: ['/src/a.txt', '/src/photos', '/src/new.txt'] })

    expect(result).toEqual({
      status: 'conflict',
      conflicts: [
        { name: 'a.txt', existing: { size: 9, modifiedAt: 1_000, isDirectory: false }, incoming: { size: 5, modifiedAt: 1_000, isDirectory: false }, canReplace: true },
        { name: 'photos', existing: { size: null, modifiedAt: 1_000, isDirectory: true }, incoming: { size: null, modifiedAt: 1_000, isDirectory: true }, canReplace: true }
      ]
    })
    expect(destination.created).toEqual([])
  })

  it('replace merges folders: same-named files replaced, kinds never swapped, nothing removed', async () => {
    const source = new MemorySide(false, {
      '/src/photos/a.jpg': 1,
      '/src/photos/b.jpg': 1,
      '/src/photos/sub/c.jpg': 1,
      '/src/photos/x/d.jpg': 1
    })
    const destination = new MemorySide(true, {
      '/dest/photos/a.jpg': 7,
      '/dest/photos/keep-me.jpg': 7,
      '/dest/photos/sub': 'dir',
      '/dest/photos/x': 7
    })
    const result = await plan(source, destination, { sourcePaths: ['/src/photos'], onConflict: 'replace' })
    if (result.status !== 'ready') throw new Error('not ready')

    expect(result.files.map((file) => [file.relativePath, file.replace])).toEqual([
      ['photos/a.jpg', true],
      ['photos/b.jpg', false],
      ['photos/sub/c.jpg', false]
    ])
    expect(result.skipped).toEqual([{ path: 'photos/x', reason: 'kind-mismatch' }])
    expect(destination.created).toEqual([])
    expect(destination.nodes.has('/dest/photos/keep-me.jpg')).toBe(true)
  })

  it('replace never swaps a top-level file for a folder', async () => {
    const source = new MemorySide(false, { '/src/a.txt': 5 })
    const destination = new MemorySide(true, { '/dest/a.txt': 'dir' })
    const result = await plan(source, destination, { onConflict: 'replace' })
    expect(result).toMatchObject({ status: 'ready', files: [], skipped: [{ path: 'a.txt', reason: 'kind-mismatch' }] })
  })

  it('keep both numbers conflicts without colliding with other selected names', async () => {
    const source = new MemorySide(false, { '/src/a.txt': 1, '/src/a (1).txt': 1, '/src/photos': 'dir' })
    const destination = new MemorySide(true, { '/dest/a.txt': 1, '/dest/photos': 'dir' })
    const result = await plan(source, destination, { sourcePaths: ['/src/a.txt', '/src/a (1).txt', '/src/photos'], onConflict: 'keep-both' })
    if (result.status !== 'ready') throw new Error('not ready')

    expect(result.files.map((file) => file.destinationPath)).toEqual(['/dest/a (2).txt', '/dest/a (1).txt'])
    expect(destination.created).toEqual(['/dest/photos (1)'])
  })

  it('skip leaves conflicting items out and queues the rest', async () => {
    const source = new MemorySide(false, { '/src/a.txt': 1, '/src/b.txt': 1 })
    const destination = new MemorySide(true, { '/dest/a.txt': 1 })
    const result = await plan(source, destination, { sourcePaths: ['/src/a.txt', '/src/b.txt'], onConflict: 'skip' })
    expect(result).toMatchObject({ status: 'ready', files: [{ name: 'b.txt' }], skipped: [{ path: 'a.txt', reason: 'exists' }] })
  })

  it('skips links to folders, special files, unreadable folders and names the destination cannot store', async () => {
    const source = new MemorySide(false, {
      '/src/tree/link-to-dir': { kind: 'directory', isSymlink: true },
      '/src/tree/link-to-file': { kind: 'file', size: 3, isSymlink: true },
      '/src/tree/socket': { kind: 'other' },
      '/src/tree/locked': { kind: 'directory', unreadable: true },
      '/src/tree/what?.txt': 1
    })
    const destination = new MemorySide(false, { '/dest': 'dir' })
    const result = await plan(source, destination, { sourcePaths: ['/src/tree'], destinationPlatform: 'win32' })
    if (result.status !== 'ready') throw new Error('not ready')

    expect(result.files.map((file) => file.relativePath)).toEqual(['tree/link-to-file'])
    expect(result.skipped).toEqual([
      { path: 'tree/link-to-dir', reason: 'link-to-folder' },
      { path: 'tree/locked', reason: 'unreadable' },
      { path: 'tree/socket', reason: 'special' },
      { path: 'tree/what?.txt', reason: 'invalid-name' }
    ])
    expect(destination.created).toEqual(['/dest/tree'])
  })

  it('follows a selected link to a folder', async () => {
    const source = new MemorySide(false, { '/src/linked': { kind: 'directory', isSymlink: true }, '/src/linked/f.txt': 1 })
    const result = await plan(source, new MemorySide(true, { '/dest': 'dir' }), { sourcePaths: ['/src/linked'] })
    expect(result).toMatchObject({ status: 'ready', files: [{ relativePath: 'linked/f.txt' }] })
  })

  it('refuses too many files or too deep a tree before creating anything', async () => {
    const source = new MemorySide(false, { '/src/big/1': 1, '/src/big/2': 1, '/src/big/3': 1, '/src/deep/a/b/c/d.txt': 1 })
    const destination = new MemorySide(true, { '/dest': 'dir' })
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/big'], limits: { maxFiles: 2, maxDepth: 64 } }))).toBe('INVALID_INPUT')
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/deep'], limits: { maxFiles: 100, maxDepth: 3 } }))).toBe('INVALID_INPUT')
    expect(destination.created).toEqual([])
  })

  it('refuses duplicate names, a missing source, and a missing or non-folder destination', async () => {
    const source = new MemorySide(false, { '/src/one/a.txt': 1, '/src/two/a.txt': 1 })
    const destination = new MemorySide(true, { '/dest': 'dir', '/file': 1 })
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/one/a.txt', '/src/two/a.txt'] }))).toBe('INVALID_INPUT')
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/nope.txt'] }))).toBe('NOT_FOUND')
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/one/a.txt'], destinationDirectory: '/gone' }))).toBe('NOT_FOUND')
    expect(await codeOf(plan(source, destination, { sourcePaths: ['/src/one/a.txt'], destinationDirectory: '/file' }))).toBe('NOT_A_DIRECTORY')
  })
})
