import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_MENU_ACTIONS } from '../shared/types/context-menu'
import { buildContextMenu, contextMenuLabel, parseContextMenuItems } from './context-menu'
import { AppError } from './errors'

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError'
  }
  return undefined
}

describe('parseContextMenuItems', () => {
  it('accepts known actions with an enabled flag', () => {
    expect(parseContextMenuItems([{ action: 'open', enabled: true }, { action: 'delete', enabled: false }])).toEqual([
      { action: 'open', enabled: true },
      { action: 'delete', enabled: false }
    ])
  })

  it('refuses anything else from the renderer', () => {
    for (const bad of [
      undefined,
      'open',
      [],
      [{ action: 'format-disk', enabled: true }],
      [{ action: 'open', enabled: 'yes' }],
      [{ action: 'open', enabled: true, label: 'Anything' }, { action: 'open', enabled: true }],
      [null],
      Array.from({ length: CONTEXT_MENU_ACTIONS.length + 1 }, () => ({ action: 'refresh', enabled: true }))
    ]) {
      expect(codeOf(() => parseContextMenuItems(bad)), JSON.stringify(bad)).toBe('INVALID_INPUT')
    }
  })

  it('drops extra fields, so the renderer cannot choose a label', () => {
    expect(parseContextMenuItems([{ action: 'open', enabled: true, label: 'Anything' }])).toEqual([{ action: 'open', enabled: true }])
  })
})

describe('buildContextMenu', () => {
  it('orders items in groups with separators between them, whatever order they arrive in', () => {
    const template = buildContextMenu(
      [
        { action: 'refresh', enabled: true },
        { action: 'move-to-trash', enabled: true },
        { action: 'rename', enabled: false },
        { action: 'upload', enabled: true },
        { action: 'open', enabled: true }
      ],
      'darwin',
      () => undefined
    )
    expect(template.map((item) => (item.type === 'separator' ? '—' : `${item.label}${item.enabled === false ? ' (off)' : ''}`))).toEqual([
      'Open',
      '—',
      'Upload',
      '—',
      'Rename… (off)',
      'Move to Trash…',
      '—',
      'Refresh'
    ])
  })

  it('reports the chosen action', () => {
    const choose = vi.fn()
    const template = buildContextMenu([{ action: 'download', enabled: true }], 'linux', choose)
    template[0]?.click?.({} as never, undefined, {} as never)
    expect(choose).toHaveBeenCalledWith('download')
  })

  it('names the Recycle Bin on Windows', () => {
    expect(contextMenuLabel('move-to-trash', 'win32')).toBe('Move to Recycle Bin…')
    expect(contextMenuLabel('move-to-trash', 'linux')).toBe('Move to Trash…')
  })
})
