import { app } from 'electron'
import { IPC } from '../../shared/constants/channels'
import type { SystemVersions } from '../../shared/types/system'
import { handle } from './handle'

/** Runtime information for the status bar. */
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
}
