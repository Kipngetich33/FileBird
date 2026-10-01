/** Commands the application menu sends to the renderer, which applies them to the active pane. */
export const MENU_COMMANDS = [
  'refresh',
  'focus-local',
  'focus-remote',
  'go-back',
  'go-up',
  'transfer',
  'select-all',
  'new-folder',
  'rename',
  'delete',
  'toggle-terminal',
  'find'
] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === 'string' && (MENU_COMMANDS as readonly string[]).includes(value)
}

export interface MenuCommandEvent {
  command: MenuCommand
}
