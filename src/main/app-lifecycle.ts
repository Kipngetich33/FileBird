import { join } from 'node:path'
import { APP_NAME } from '../shared/constants/app'

/**
 * Where app data lives. The installed app has always used a folder named after
 * the npm package ("fly"), which Electron derives from the app's name; it is
 * pinned so that renaming the app keeps saved connections and trusted host keys.
 * Unpackaged runs keep their own (Milestone 10 plan D6), matching the
 * "Fly (development)" keychain namespace, so a developer's saved connections
 * never appear in the installed app with secrets it can't read. An explicit
 * --user-data-dir (smoke tests, dev checks) always wins: null, keep it.
 */
export function userDataFolder(options: { isPackaged: boolean; hasUserDataSwitch: boolean; appData: string }): string | null {
  if (options.hasUserDataSwitch) return null
  return join(options.appData, options.isPackaged ? 'fly' : 'Fly (development)')
}

/**
 * Where a download goes when the user hasn't said: the Downloads folder, as a
 * browser would. Dragging is how you choose somewhere else, and the local pane
 * still opens in the home folder. Anything missing — no Downloads folder, or
 * the same folder as home — falls back to the home folder.
 */
export function downloadDirectory(options: { home: string; downloads: string | null; isDirectory: (path: string) => boolean }): string {
  const { home, downloads, isDirectory } = options
  if (downloads === null || downloads === home || !isDirectory(downloads)) return home
  return downloads
}

export interface StopTransfersQuestion {
  type: 'warning'
  message: string
  detail: string
  buttons: [string, string]
  defaultId: 0
  cancelId: 0
}

/**
 * Whether quitting, or closing the window (which disconnects), needs asking
 * first because transfers would be cancelled (plan D5). Button 1 confirms.
 */
export function stopTransfersQuestion(activeTransfers: number, action: 'quit' | 'close'): StopTransfersQuestion | null {
  if (activeTransfers <= 0) return null
  const what = activeTransfers === 1 ? '1 transfer' : `${activeTransfers} transfers`
  return {
    type: 'warning',
    message: action === 'quit' ? `Quit ${APP_NAME} and cancel ${what}?` : `Close the window and cancel ${what}?`,
    detail:
      action === 'quit'
        ? `${activeTransfers === 1 ? 'It is' : 'They are'} still queued or running. Partly transferred files are removed.`
        : `Closing the window disconnects from the server, so ${activeTransfers === 1 ? 'it' : 'they'} can't continue. Partly transferred files are removed.`,
    buttons: ['Cancel', action === 'quit' ? 'Quit' : 'Close'],
    defaultId: 0,
    cancelId: 0
  }
}

/** How long the start screen shows before the main window (plan: "dances around" for a few seconds). */
export const SPLASH_DURATION_MS = 6000

/**
 * The start screen's duration. Unpackaged builds accept FLY_SPLASH_MS (0 turns
 * it off) so development restarts can skip it; the installed app always shows it.
 */
export function splashDuration(options: { isPackaged: boolean; override: string | undefined }): number {
  if (options.isPackaged || options.override === undefined || options.override.trim() === '') return SPLASH_DURATION_MS
  const value = Number(options.override)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 30_000) : SPLASH_DURATION_MS
}

/** How much longer the start screen should stay, given when it appeared (null: not yet). */
export function splashWait(options: { shownAt: number | null; now: number; durationMs: number }): number {
  if (options.shownAt === null) return options.durationMs
  return Math.max(0, options.durationMs - (options.now - options.shownAt))
}
