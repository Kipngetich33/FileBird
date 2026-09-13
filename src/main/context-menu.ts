import type { MenuItemConstructorOptions } from 'electron'
import { type ContextMenuAction, type ContextMenuItem, isContextMenuAction } from '../shared/types/context-menu'
import { AppError } from './errors'
import { assertBoolean, assertObject } from './ipc/validate'

/** Actions that sit together; a separator goes between groups. */
const GROUPS: ContextMenuAction[][] = [['open'], ['upload', 'download'], ['new-folder', 'rename', 'move-to-trash', 'delete'], ['refresh']]

export function contextMenuLabel(action: ContextMenuAction, platform: NodeJS.Platform): string {
  switch (action) {
    case 'open':
      return 'Open'
    case 'upload':
      return 'Upload'
    case 'download':
      return 'Download'
    case 'new-folder':
      return 'New Folder'
    case 'rename':
      return 'Rename…'
    case 'move-to-trash':
      return platform === 'win32' ? 'Move to Recycle Bin…' : 'Move to Trash…'
    case 'delete':
      return 'Delete…'
    case 'refresh':
      return 'Refresh'
  }
}

/** Checks a menu request from the renderer: known actions, each at most once, in any order. */
export function parseContextMenuItems(value: unknown): ContextMenuItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GROUPS.flat().length) {
    throw new AppError('INVALID_INPUT', 'Expected a list of menu items.')
  }
  const items = value.map((raw, index) => {
    const item = assertObject(raw, `items[${index}]`)
    if (!isContextMenuAction(item['action'])) throw new AppError('INVALID_INPUT', `Unknown menu action at items[${index}].`)
    return { action: item['action'], enabled: assertBoolean(item['enabled'], `items[${index}].enabled`) }
  })
  if (new Set(items.map((item) => item.action)).size !== items.length) {
    throw new AppError('INVALID_INPUT', 'A menu action appears twice.')
  }
  return items
}

/**
 * The native menu's template, in a fixed order with separators between groups.
 * Pure, so it can be unit-tested; `choose` is called with the clicked action.
 */
export function buildContextMenu(items: ContextMenuItem[], platform: NodeJS.Platform, choose: (action: ContextMenuAction) => void): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  for (const group of GROUPS) {
    const present = group.flatMap((action) => items.filter((item) => item.action === action))
    if (present.length === 0) continue
    if (template.length > 0) template.push({ type: 'separator' })
    for (const item of present) {
      template.push({ id: `context:${item.action}`, label: contextMenuLabel(item.action, platform), enabled: item.enabled, click: () => choose(item.action) })
    }
  }
  return template
}
