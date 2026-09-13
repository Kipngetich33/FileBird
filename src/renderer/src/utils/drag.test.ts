import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/types/files'
import { decodeDrag, dragSourceOf, dragType, encodeDrag } from './drag'

const entry = (name: string, kind: FileEntry['kind'] = 'file'): FileEntry => ({
  name,
  path: `/srv/${name}`,
  kind,
  isSymlink: false,
  isHidden: false,
  size: 1,
  modifiedAt: 0
})

describe('drag payload', () => {
  it('round-trips name, path and kind only', () => {
    expect(decodeDrag(encodeDrag([entry('a.txt'), entry('photos', 'directory')]))).toEqual([
      { name: 'a.txt', path: '/srv/a.txt', kind: 'file' },
      { name: 'photos', path: '/srv/photos', kind: 'directory' }
    ])
  })

  it('reads the source side from the types alone', () => {
    expect(dragSourceOf(['text/plain', dragType('local')])).toBe('local')
    expect(dragSourceOf([dragType('remote')])).toBe('remote')
  })

  it('refuses drags that are not exactly one Fly drag', () => {
    expect(dragSourceOf(['Files'])).toBeNull()
    expect(dragSourceOf(['text/plain', 'text/uri-list'])).toBeNull()
    expect(dragSourceOf([dragType('local'), dragType('remote')])).toBeNull()
    expect(dragSourceOf(['application/x-fly-entries+elsewhere'])).toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['not a list', '{"name":"a"}'],
    ['an empty list', '[]'],
    ['a missing path', '[{"name":"a","kind":"file"}]'],
    ['an unknown kind', '[{"name":"a","path":"/a","kind":"socket"}]'],
    ['a non-object item', '["/a"]']
  ])('ignores %s', (_label, raw) => {
    expect(decodeDrag(raw)).toBeNull()
  })
})
