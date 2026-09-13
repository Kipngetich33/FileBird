import type { ContextMenuItem } from '@shared/types/context-menu'
import type { FileEntry } from '@shared/types/files'

export interface FileMenuContext {
  side: 'local' | 'remote'
  /** What the menu acts on: the right-clicked row, or the selection it belongs to. Empty for the background. */
  entries: FileEntry[]
  /** Whether a transfer could start now (for the local pane, a server must be connected). */
  canTransfer: boolean
  /** Whether this pane can create, rename and delete. */
  canModify: boolean
  /** Local deletes go to the Trash; remote deletes are permanent. */
  trash: boolean
}

/** The right-click menu for a file list, as the renderer describes it to the main process. */
export function fileContextMenu({ side, entries, canTransfer, canModify, trash }: FileMenuContext): ContextMenuItem[] {
  const modify = (action: ContextMenuItem['action'], enabled = true): ContextMenuItem => ({ action, enabled: canModify && enabled })
  if (entries.length === 0) return [modify('new-folder'), { action: 'refresh', enabled: true }]

  const only = entries.length === 1 ? entries[0] : undefined
  const items: ContextMenuItem[] = []
  if (only?.kind === 'directory') items.push({ action: 'open', enabled: true })
  items.push({
    action: side === 'local' ? 'upload' : 'download',
    enabled: canTransfer && entries.some((entry) => entry.kind !== 'other')
  })
  items.push(modify('new-folder'), modify('rename', only !== undefined), modify(trash ? 'move-to-trash' : 'delete'))
  items.push({ action: 'refresh', enabled: true })
  return items
}
