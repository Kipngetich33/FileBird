import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/types/files'
import { fileContextMenu, terminalContextMenu } from './context-menu'

const entry = (name: string, kind: FileEntry['kind']): FileEntry => ({
  name,
  path: `/home/me/${name}`,
  kind,
  size: 0,
  modifiedAt: null,
  isHidden: false,
  isSymlink: false
})

const folder = entry('photos', 'directory')
const file = entry('notes.txt', 'file')
const broken = entry('broken-link', 'other')
const local = { side: 'local', canTransfer: true, canModify: true, trash: true } as const
const remote = { side: 'remote', canTransfer: true, canModify: true, trash: false } as const
const actions = (items: ReturnType<typeof fileContextMenu>): string[] => items.map((item) => `${item.action}${item.enabled ? '' : ' (off)'}`)

describe('fileContextMenu', () => {
  it('offers Open first for a single folder, then its transfer, file operations and Refresh', () => {
    expect(actions(fileContextMenu({ ...local, entries: [folder] }))).toEqual(['open', 'upload', 'new-folder', 'rename', 'move-to-trash', 'refresh'])
  })

  it('has no Open for a file, and downloads and deletes permanently on the server', () => {
    expect(actions(fileContextMenu({ ...remote, entries: [file] }))).toEqual(['download', 'new-folder', 'rename', 'delete', 'refresh'])
  })

  it('acts on several items at once, but renames only one', () => {
    expect(actions(fileContextMenu({ ...local, entries: [folder, file] }))).toEqual(['upload', 'new-folder', 'rename (off)', 'move-to-trash', 'refresh'])
  })

  it("can't transfer before a server is connected, or when only broken links are chosen", () => {
    expect(actions(fileContextMenu({ ...local, canTransfer: false, entries: [file] }))[0]).toBe('upload (off)')
    expect(actions(fileContextMenu({ ...local, entries: [broken] }))[0]).toBe('upload (off)')
  })

  it('offers New Folder and Refresh on the empty part of the list', () => {
    expect(actions(fileContextMenu({ ...local, entries: [] }))).toEqual(['new-folder', 'refresh'])
  })

  it('disables file operations for a pane that has none', () => {
    expect(actions(fileContextMenu({ ...local, canModify: false, entries: [folder] }))).toEqual(['open', 'upload', 'new-folder (off)', 'rename (off)', 'move-to-trash (off)', 'refresh'])
  })
})

describe('terminalContextMenu', () => {
  it('offers both splits, a new terminal and closing this one', () => {
    expect(terminalContextMenu({ canSplit: true, canClose: true })).toEqual([
      { action: 'split-right', enabled: true },
      { action: 'split-down', enabled: true },
      { action: 'new-terminal', enabled: true },
      { action: 'close-split', enabled: true }
    ])
  })

  it('greys the splits once the pane runs as many shells as it may', () => {
    const items = terminalContextMenu({ canSplit: false, canClose: true })
    expect(items.filter((item) => item.enabled).map((item) => item.action)).toEqual(['close-split'])
  })

  it('offers nothing to close in a tab that has only one pane', () => {
    const items = terminalContextMenu({ canSplit: true, canClose: false })
    expect(items.find((item) => item.action === 'close-split')?.enabled).toBe(false)
  })
})
