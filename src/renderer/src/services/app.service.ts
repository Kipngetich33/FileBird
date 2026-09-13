import type { MenuCommand } from '@shared/types/menu'

/** Application-level events from the main process. */
export const appService = {
  /** Returns an unsubscribe function. */
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => window.api.app.onMenuCommand(listener)
}
