import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/constants/channels'
import type { ConnectOutcome, ConnectRequest, ConnectionClosedEvent } from '../shared/types/connection'
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
  },
  sftp: {
    connect: (request: ConnectRequest): Promise<ConnectOutcome> =>
      ipcRenderer.invoke(IPC.SFTP_CONNECT, request),
    trustHostKeyAndConnect: (token: string): Promise<ConnectOutcome> =>
      ipcRenderer.invoke(IPC.SFTP_TRUST_HOST_KEY_AND_CONNECT, token),
    forgetHostKey: (host: string, port: number): Promise<void> =>
      ipcRenderer.invoke(IPC.SFTP_FORGET_HOST_KEY, host, port),
    listDirectory: (connectionId: string, path: string): Promise<DirectoryListing> =>
      ipcRenderer.invoke(IPC.SFTP_LIST_DIRECTORY, connectionId, path),
    disconnect: (connectionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SFTP_DISCONNECT, connectionId),
    /** Returns an unsubscribe function. The listener receives the payload only, never Electron's event object. */
    onConnectionClosed: (listener: (event: ConnectionClosedEvent) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: ConnectionClosedEvent): void => listener(payload)
      ipcRenderer.on(IPC_EVENTS.SFTP_CONNECTION_CLOSED, forward)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.SFTP_CONNECTION_CLOSED, forward)
      }
    }
  }
} as const

export type FlyApi = typeof api

contextBridge.exposeInMainWorld('api', api)
