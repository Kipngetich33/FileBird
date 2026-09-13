import { join } from 'node:path'

/**
 * Where unpackaged runs keep their app data (Milestone 10 plan D6), matching the
 * "Fly (development)" keychain namespace, so a developer's saved connections
 * never appear in the installed app with secrets it can't read. An explicit
 * --user-data-dir (smoke tests, dev checks) always wins. Null: keep the default.
 */
export function developmentUserData(options: { isPackaged: boolean; hasUserDataSwitch: boolean; appData: string }): string | null {
  if (options.isPackaged || options.hasUserDataSwitch) return null
  return join(options.appData, 'Fly (development)')
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
    message: action === 'quit' ? `Quit Fly and cancel ${what}?` : `Close the window and cancel ${what}?`,
    detail:
      action === 'quit'
        ? `${activeTransfers === 1 ? 'It is' : 'They are'} still queued or running. Partly transferred files are removed.`
        : `Closing the window disconnects from the server, so ${activeTransfers === 1 ? 'it' : 'they'} can't continue. Partly transferred files are removed.`,
    buttons: ['Cancel', action === 'quit' ? 'Quit' : 'Close'],
    defaultId: 0,
    cancelId: 0
  }
}
