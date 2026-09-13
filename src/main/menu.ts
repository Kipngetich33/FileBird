import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/types/menu'

export interface ApplicationMenuOptions {
  platform: NodeJS.Platform
  /** Unpackaged builds get a Developer menu; the shipped app does not. */
  isDev: boolean
  send: (command: MenuCommand) => void
}

/** Stable id for a command item, so tests and code can find it with getMenuItemById. */
export const menuItemId = (command: MenuCommand): string => `command:${command}`

/**
 * The application menu, replacing Electron's default. The default binds
 * CmdOrCtrl+R to reloading the whole renderer (losing every pane's state) and
 * ships Toggle Developer Tools to users.
 *
 * Pure: builds a template only, so every platform's menu is unit-testable.
 */
export function buildApplicationMenu({ platform, isDev, send }: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  const command = (id: MenuCommand, label: string, accelerator: string): MenuItemConstructorOptions => ({
    id: menuItemId(id),
    label,
    accelerator,
    click: () => send(id)
  })

  const template: MenuItemConstructorOptions[] = []
  if (isMac) template.push({ role: 'appMenu' })

  template.push(
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    // Required: without the Edit role, Cmd+C / Cmd+V / Cmd+A stop working in text fields on macOS.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        command('refresh', 'Refresh', 'CmdOrCtrl+R'),
        { type: 'separator' },
        command('focus-local', 'Focus Local Pane', 'CmdOrCtrl+1'),
        command('focus-remote', 'Focus Remote Pane', 'CmdOrCtrl+2'),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Go',
      submenu: [
        command('go-back', 'Back', isMac ? 'Cmd+[' : 'Alt+Left'),
        command('go-up', 'Parent Folder', isMac ? 'Cmd+Up' : 'Alt+Up')
      ]
    }
  )

  if (isMac) template.push({ role: 'windowMenu' })

  if (isDev) {
    template.push({
      label: 'Developer',
      submenu: [{ role: 'forceReload', label: 'Reload App' }, { role: 'toggleDevTools' }]
    })
  }

  return template
}
