import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/constants/channels'
import type { ConnectOutcome, ConnectionClosedEvent } from '../shared/types/connection'
import type {
  ConnectionInput,
  ConnectionSummary,
  ImportPreview,
  KeyInfo,
  SecretEntry
} from '../shared/types/connections'
import type { DirectoryListing } from '../shared/types/files'
import { type MenuCommand, isMenuCommand } from '../shared/types/menu'
import type { SystemVersions } from '../shared/types/system'

/**
 * The ONLY bridge between the renderer and Node.
 *
 * Every function here is hand-written and explicit. `ipcRenderer` itself is
 * never exposed, so the renderer cannot invoke an arbitrary channel — it can
 * only call the methods defined below (spec section 20).
 */
const api = {
  app: {
    /** Application menu commands. Returns an unsubscribe function; unknown commands are dropped here. */
    onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: { command?: unknown } | null): void => {
        if (isMenuCommand(payload?.command)) listener(payload.command)
      }
      ipcRenderer.on(IPC_EVENTS.MENU_COMMAND, forward)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.MENU_COMMAND, forward)
      }
    }
  },
  system: {
    getVersion: (): Promise<SystemVersions> => ipcRenderer.invoke(IPC.SYSTEM_GET_VERSION)
  },
  local: {
    getHomeDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.LOCAL_GET_HOME_DIRECTORY),
    listDirectory: (path: string): Promise<DirectoryListing> =>
      ipcRenderer.invoke(IPC.LOCAL_LIST_DIRECTORY, path)
  },
  connections: {
    list: (): Promise<ConnectionSummary[]> => ipcRenderer.invoke(IPC.CONNECTIONS_LIST),
    create: (input: ConnectionInput): Promise<ConnectionSummary> => ipcRenderer.invoke(IPC.CONNECTIONS_CREATE, input),
    update: (id: string, input: ConnectionInput): Promise<ConnectionSummary> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_UPDATE, id, input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.CONNECTIONS_DELETE, id),
    forgetSecret: (id: string): Promise<void> => ipcRenderer.invoke(IPC.CONNECTIONS_FORGET_SECRET, id),
    connect: (id: string, secret?: SecretEntry): Promise<ConnectOutcome> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_CONNECT, id, secret),
    connectUnsaved: (input: ConnectionInput, secret?: SecretEntry): Promise<ConnectOutcome> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_CONNECT_UNSAVED, input, secret)
  },
  keys: {
    pick: (): Promise<string | null> => ipcRenderer.invoke(IPC.KEYS_PICK),
    inspect: (path: string): Promise<KeyInfo> => ipcRenderer.invoke(IPC.KEYS_INSPECT, path)
  },
  sshConfig: {
    preview: (options: { allowCommands: boolean }): Promise<ImportPreview> =>
      ipcRenderer.invoke(IPC.SSH_CONFIG_PREVIEW, options),
    import: (aliases: string[], options: { allowCommands: boolean }): Promise<ConnectionSummary[]> =>
      ipcRenderer.invoke(IPC.SSH_CONFIG_IMPORT, aliases, options)
  },
  sftp: {
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
