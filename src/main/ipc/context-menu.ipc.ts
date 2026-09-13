import { BrowserWindow, Menu } from 'electron'
import { IPC } from '../../shared/constants/channels'
import type { ContextMenuAction } from '../../shared/types/context-menu'
import { buildContextMenu, parseContextMenuItems } from '../context-menu'
import { handleWithSender } from './handle'

/**
 * Shows a file list's right-click menu as a native menu at the pointer, and
 * resolves with the chosen action, or null when it closes without a choice.
 */
export function registerContextMenuIpc(): void {
  handleWithSender<ContextMenuAction | null>(IPC.APP_SHOW_CONTEXT_MENU, (sender, rawItems) => {
    const items = parseContextMenuItems(rawItems)
    const window = BrowserWindow.fromWebContents(sender)
    return new Promise((resolve) => {
      const menu = Menu.buildFromTemplate(buildContextMenu(items, process.platform, resolve))
      // The close callback can arrive before the click that closed the menu, so a
      // choice gets a turn to settle the promise first.
      menu.popup({ ...(window === null ? {} : { window }), callback: () => setTimeout(() => resolve(null), 0) })
    })
  })
}
