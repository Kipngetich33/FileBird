import { describe, expect, it } from 'vitest'
import { isSymlinkMode, kindOfMode, toRemoteEntry, type RemoteAttributes } from './remote-entries'

const DIR = 0o040755
const FILE = 0o100644
const LINK = 0o120777
const SOCKET = 0o140755

const noStat = (): Promise<RemoteAttributes> => Promise.reject(new Error('should not stat'))

describe('mode bits', () => {
  it.each([
    [DIR, 'directory'],
    [FILE, 'file'],
    [LINK, 'other'],
    [SOCKET, 'other'],
    [undefined, 'other']
  ])('mode %s is %s', (mode, kind) => {
    expect(kindOfMode(mode)).toBe(kind)
  })

  it('recognises symlinks', () => {
    expect(isSymlinkMode(LINK)).toBe(true)
    expect(isSymlinkMode(FILE)).toBe(false)
    expect(isSymlinkMode(undefined)).toBe(false)
  })
})

describe('toRemoteEntry', () => {
  it('builds a POSIX path and converts seconds to milliseconds', async () => {
    const entry = await toRemoteEntry('/home/u', { filename: 'a.txt', attrs: { mode: FILE, size: 12, mtime: 1_700_000_000 } }, noStat)
    expect(entry).toEqual({
      name: 'a.txt',
      path: '/home/u/a.txt',
      isHidden: false,
      kind: 'file',
      isSymlink: false,
      size: 12,
      modifiedAt: 1_700_000_000_000
    })
  })

  it('joins correctly at the root', async () => {
    expect((await toRemoteEntry('/', { filename: 'etc', attrs: { mode: DIR } }, noStat)).path).toBe('/etc')
  })

  it('gives folders no size and marks dotfiles hidden', async () => {
    const entry = await toRemoteEntry('/x', { filename: '.config', attrs: { mode: DIR, size: 4096, mtime: 1 } }, noStat)
    expect(entry).toMatchObject({ kind: 'directory', size: null, isHidden: true })
  })

  it('follows a symlink to find what it points at', async () => {
    const statted: string[] = []
    const entry = await toRemoteEntry('/x', { filename: 'link', attrs: { mode: LINK, size: 7, mtime: 5 } }, (path) => {
      statted.push(path)
      return Promise.resolve({ mode: DIR, size: 4096, mtime: 9 })
    })
    expect(statted).toEqual(['/x/link'])
    expect(entry).toMatchObject({ kind: 'directory', isSymlink: true, size: null, modifiedAt: 9000 })
  })

  it('reports a link whose target is gone as a broken link, without throwing', async () => {
    const entry = await toRemoteEntry('/x', { filename: 'dangling', attrs: { mode: LINK, mtime: 5 } }, () =>
      Promise.reject(Object.assign(new Error('No such file'), { code: 2 }))
    )
    expect(entry).toMatchObject({ kind: 'other', isSymlink: true, size: null, modifiedAt: 5000 })
  })

  it('tolerates attributes the server did not send', async () => {
    expect(await toRemoteEntry('/x', { filename: 'mystery', attrs: {} }, noStat)).toMatchObject({
      kind: 'other',
      size: null,
      modifiedAt: null
    })
  })
})
