import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/types/menu'

export interface ApplicationMenuOptions {
  platform: NodeJS.Platform
  /** Unpackaged builds get a Developer menu; the shipped app does not. */
  isDev: boolean
  send: (command: MenuCommand) => void
}

/**
 * Commands that act on files. While a terminal has focus these are disabled, so
 * their keys reach the shell instead (Milestone 11 plan D6): macOS always
 * registers a menu accelerator, so Cmd+R and friends would never arrive.
 */
export const TERMINAL_SUPPRESSED_COMMANDS: MenuCommand[] = [
  'find',
  'refresh',
  'select-all',
  'go-back',
  'go-up',
  'transfer',
  'new-folder',
  'rename',
  'delete'
]

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
  const command = (id: MenuCommand, label: string, accelerator: string, extra: MenuItemConstructorOptions = {}): MenuItemConstructorOptions => ({
    id: menuItemId(id),
    label,
    accelerator,
    click: () => send(id),
    ...extra
  })

  const template: MenuItemConstructorOptions[] = []
  if (isMac) template.push({ role: 'appMenu' })

  template.push(
    {
      label: 'File',
      submenu: [
        command('new-folder', 'New Folder', 'CmdOrCtrl+Shift+N'),
        command('rename', 'Rename…', 'F2'),
        // The focused file list handles the key itself: as a menu accelerator it would
        // take Delete / Cmd+Backspace away from text fields. Windows and Linux can show
        // an accelerator without registering it; macOS can't, so there it isn't shown.
        isMac
          ? command('delete', 'Delete…', '', { accelerator: undefined })
          : command('delete', 'Delete…', 'Delete', { registerAccelerator: false }),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Required: without these roles, Cmd+C / Cmd+V stop working in text fields on macOS.
    // Select All is a command instead: the role would swallow Cmd+A before a file
    // list could see it. The renderer selects text in a focused field, files elsewhere.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
        { type: 'separator' },
        command('select-all', 'Select All', 'CmdOrCtrl+A')
      ]
    },
    {
      label: 'View',
      submenu: [
        command('refresh', 'Refresh', 'CmdOrCtrl+R'),
        { type: 'separator' },
        command('focus-local', 'Focus Local Pane', 'CmdOrCtrl+1'),
        command('focus-remote', 'Focus Remote Pane', 'CmdOrCtrl+2'),
        { type: 'separator' },
        // Deliberately not suppressed while a terminal has focus: this is how
        // the keyboard gets back out of it.
        command('toggle-terminal', 'Files / Terminal', 'CmdOrCtrl+`'),
        command('find', 'Search This Folder', 'CmdOrCtrl+F'),
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
    },
    {
      label: 'Transfer',
      submenu: [command('transfer', 'Transfer to Other Pane', 'CmdOrCtrl+T')]
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
