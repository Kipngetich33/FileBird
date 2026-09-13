import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/channels'
import type { DirectoryListing } from '../shared/types/files'
import type { SystemVersions } from '../shared/types/system'

/**
 * The ONLY bridge between the renderer and Node.
 *
 * Every function here is hand-written and explicit. `ipcRenderer` itself is
 * never exposed, so the renderer cannot invoke an arbitrary channel — it can
 * only call the methods defined below (spec section 20).
 */
const api = {
  system: {
    getVersion: (): Promise<SystemVersions> => ipcRenderer.invoke(IPC.SYSTEM_GET_VERSION)
  },
  local: {
    getHomeDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.LOCAL_GET_HOME_DIRECTORY),
    listDirectory: (path: string): Promise<DirectoryListing> =>
      ipcRenderer.invoke(IPC.LOCAL_LIST_DIRECTORY, path)
  }
} as const

export type FlyApi = typeof api

contextBridge.exposeInMainWorld('api', api)
