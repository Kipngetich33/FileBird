import { describe, expect, it } from 'vitest'
import type { FileEntry, FileKind } from '@shared/types/files'
import { formatModified, formatSize, matchesSearch, sortEntries, typeLabel } from './file-entries'

function entry(name: string, kind: FileKind = 'file', extra: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    kind,
    isSymlink: false,
    isHidden: name.startsWith('.'),
    size: 0,
    modifiedAt: 0,
    ...extra
  }
}

const names = (entries: FileEntry[]): string[] => entries.map((item) => item.name)

describe('sortEntries', () => {
  it('puts folders before files', () => {
    const sorted = sortEntries([entry('b.txt'), entry('zeta', 'directory'), entry('a.txt')])
    expect(names(sorted)).toEqual(['zeta', 'a.txt', 'b.txt'])
  })

  it('orders numbers naturally and ignores case', () => {
    const sorted = sortEntries([entry('file10'), entry('Banana'), entry('file2'), entry('apple')])
    expect(names(sorted)).toEqual(['apple', 'Banana', 'file2', 'file10'])
  })

  it('orders names that differ only by case deterministically', () => {
    const forward = sortEntries([entry('a'), entry('A')])
    const reverse = sortEntries([entry('A'), entry('a')])
    expect(names(forward)).toEqual(names(reverse))
  })

  it('does not mutate its input', () => {
    const input = [entry('b'), entry('a')]
    sortEntries(input)
    expect(names(input)).toEqual(['b', 'a'])
  })
})

describe('formatSize', () => {
  it.each([
    [null, '—'],
    [0, '0 bytes'],
    [1, '1 byte'],
    [999, '999 bytes'],
    [1000, '1 KB'],
    [1500, '1.5 KB'],
    [9960, '10 KB'],
    [12_345, '12 KB'],
    [999_999, '1 MB'],
    [2_500_000_000, '2.5 GB']
  ])('formats %s as %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected)
  })
})

describe('formatModified', () => {
  const utc = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

  it('shows a dash when the time is unknown', () => {
    expect(formatModified(null, utc)).toBe('—')
  })

  it('formats epoch milliseconds', () => {
    expect(formatModified(Date.UTC(2026, 0, 15, 14, 30), utc)).toContain('Jan 15, 2026')
  })
})

describe('typeLabel', () => {
  it.each([
    [entry('src', 'directory'), 'Folder'],
    [entry('linked', 'directory', { isSymlink: true }), 'Folder'],
    [entry('notes.txt'), 'TXT file'],
    [entry('archive.tar.gz'), 'GZ file'],
    [entry('Makefile'), 'File'],
    [entry('.hidden'), 'File'],
    [entry('trailing.'), 'File'],
    [entry('dangling', 'other', { isSymlink: true }), 'Broken link'],
    [entry('socket', 'other'), 'Other']
  ])('labels %j as %s', (item, expected) => {
    expect(typeLabel(item)).toBe(expected)
  })
})

describe('matchesSearch', () => {
  it('matches part of a name, whatever the case', () => {
    expect(matchesSearch('Quarterly Report.pdf', 'report')).toBe(true)
    expect(matchesSearch('quarterly report.pdf', 'REPORT')).toBe(true)
    expect(matchesSearch('notes.txt', 'report')).toBe(false)
  })

  it('shows the whole folder when nothing has been typed', () => {
    expect(matchesSearch('anything', '')).toBe(true)
    expect(matchesSearch('anything', '   ')).toBe(true)
  })

  it('ignores spaces around what was typed, but not inside it', () => {
    expect(matchesSearch('my file.txt', '  file ')).toBe(true)
    expect(matchesSearch('myfile.txt', 'my file')).toBe(false)
  })
})
