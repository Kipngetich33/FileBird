import { app } from 'electron'
import { IPC } from '../../shared/constants/channels'
import type { PingResult, SystemVersions } from '../../shared/types/system'
import { handle } from './handle'
import { assertString } from './validate'

/**
 * Milestone 1 test surface.
 *
 * These two calls exist to prove the renderer -> preload -> IPC -> main -> back
 * round trip works end to end, and to establish the validation pattern that
 * every later handler will follow.
 */
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

  handle<PingResult>(IPC.SYSTEM_PING, (rawMessage) => ({
    message: assertString(rawMessage, 'message', 200),
    receivedAt: new Date().toISOString()
  }))
}
