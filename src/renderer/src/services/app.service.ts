import type { ContextMenuAction, ContextMenuItem } from '@shared/types/context-menu'
import type { MenuCommand } from '@shared/types/menu'

/** Application-level events from the main process. */
export const appService = {
  /** Returns an unsubscribe function. */
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => window.api.app.onMenuCommand(listener),
  /** A native right-click menu; resolves with the chosen action, or null if it closed without one or couldn't open. */
  showContextMenu: (items: ContextMenuItem[]): Promise<ContextMenuAction | null> => window.api.app.showContextMenu(items).catch(() => null)
}
