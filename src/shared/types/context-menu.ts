/**
 * What a right-click menu can offer, in a file list or in a terminal. The
 * renderer says which actions apply and whether each is enabled; the main
 * process owns the labels and shows the native menu, so the renderer can't put
 * arbitrary text in it.
 */
export const CONTEXT_MENU_ACTIONS = [
  'open',
  'upload',
  'download',
  'new-folder',
  'rename',
  'move-to-trash',
  'delete',
  'refresh',
  // A terminal's menu (user request, 2026-10-20: split from the right-click menu).
  'split-right',
  'split-down',
  'close-split',
  'new-terminal'
] as const

export type ContextMenuAction = (typeof CONTEXT_MENU_ACTIONS)[number]

export interface ContextMenuItem {
  action: ContextMenuAction
  enabled: boolean
}

export function isContextMenuAction(value: unknown): value is ContextMenuAction {
  return typeof value === 'string' && (CONTEXT_MENU_ACTIONS as readonly string[]).includes(value)
}
