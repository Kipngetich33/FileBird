import { app, shell } from 'electron'
import { statSync } from 'node:fs'
import { IPC } from '../../shared/constants/channels'
import type { SystemVersions } from '../../shared/types/system'
import { AppError } from '../errors'
import { handle } from './handle'
import { assertAbsolutePath } from './validate'

/** Runtime information for the status bar, and showing a finished transfer on this computer. */
export function registerSystemIpc(): void {
  handle<SystemVersions>(IPC.SYSTEM_GET_VERSION, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged
  }))

  /**
   * Opens the file manager with this file selected, the way a browser's
   * downloads list does. Only a file that is really there: a transfer's local
   * file can have been moved or deleted since.
   */
  handle<void>(IPC.SYSTEM_REVEAL_IN_FOLDER, (rawPath) => {
    const path = assertAbsolutePath(rawPath, 'path')
    try {
      statSync(path)
    } catch {
      throw new AppError('NOT_FOUND', "That file isn't there any more. It may have been moved or deleted.")
    }
    shell.showItemInFolder(path)
  })
}
