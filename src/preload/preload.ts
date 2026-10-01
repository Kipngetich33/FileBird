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
import type { DeleteOutcome, FileTarget, MoveOutcome } from '../shared/types/file-operations'
import type { ContextMenuAction, ContextMenuItem } from '../shared/types/context-menu'
import { type MenuCommand, isMenuCommand } from '../shared/types/menu'
import type { TerminalDataEvent, TerminalExitEvent, TerminalOpenInput, TerminalOpened } from '../shared/types/terminal'
import type { StartTransferOutcome, StartTransferRequest, TransferJob, TransferQueueUpdate } from '../shared/types/transfers'
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
    },
    /** Shows a native right-click menu of these actions; resolves with the one chosen, or null. */
    showContextMenu: (items: ContextMenuItem[]): Promise<ContextMenuAction | null> => ipcRenderer.invoke(IPC.APP_SHOW_CONTEXT_MENU, items)
  },
  system: {
    getVersion: (): Promise<SystemVersions> => ipcRenderer.invoke(IPC.SYSTEM_GET_VERSION),
    /** Shows a file on this computer in Finder or the file manager. */
    revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke(IPC.SYSTEM_REVEAL_IN_FOLDER, path)
  },
  local: {
    /** The folder the local pane opens in. */
    getStartDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.LOCAL_GET_START_DIRECTORY),
    /** Where a download goes when the user hasn't dragged it to a folder. */
    getDownloadFolder: (): Promise<string> => ipcRenderer.invoke(IPC.LOCAL_GET_DOWNLOAD_FOLDER),
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
  files: {
    createFolder: (target: FileTarget, parent: string, name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.FILES_CREATE_FOLDER, target, parent, name),
    rename: (target: FileTarget, path: string, newName: string): Promise<string> =>
      ipcRenderer.invoke(IPC.FILES_RENAME, target, path, newName),
    delete: (target: FileTarget, paths: string[]): Promise<DeleteOutcome> => ipcRenderer.invoke(IPC.FILES_DELETE, target, paths),
    /** Moves items into a folder on the same side; never copies, never overwrites. */
    move: (target: FileTarget, paths: string[], destination: string): Promise<MoveOutcome> =>
      ipcRenderer.invoke(IPC.FILES_MOVE, target, paths, destination)
  },
  transfers: {
    start: (request: StartTransferRequest): Promise<StartTransferOutcome> =>
      ipcRenderer.invoke(IPC.TRANSFERS_START, request),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.TRANSFERS_CANCEL, id),
    cancelAll: (): Promise<void> => ipcRenderer.invoke(IPC.TRANSFERS_CANCEL_ALL),
    retry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.TRANSFERS_RETRY, id),
    retryFailed: (): Promise<number> => ipcRenderer.invoke(IPC.TRANSFERS_RETRY_FAILED),
    clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.TRANSFERS_CLEAR_FINISHED),
    list: (): Promise<TransferJob[]> => ipcRenderer.invoke(IPC.TRANSFERS_LIST),
    /** Returns an unsubscribe function. The listener receives the payload only. */
    onUpdate: (listener: (update: TransferQueueUpdate) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: TransferQueueUpdate): void => listener(payload)
      ipcRenderer.on(IPC_EVENTS.TRANSFER_UPDATE, forward)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TRANSFER_UPDATE, forward)
      }
    }
  },
  terminals: {
    /** Opens a shell for a pane and returns its session id. */
    open: (input: TerminalOpenInput): Promise<TerminalOpened> => ipcRenderer.invoke(IPC.TERMINAL_OPEN, input),
    /** Keystrokes, as bytes: text would break a character split across two chunks. */
    write: (id: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke(IPC.TERMINAL_WRITE, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke(IPC.TERMINAL_RESIZE, id, cols, rows),
    /** How much output the terminal has drawn, which is what lets a paused shell continue. */
    acknowledge: (id: string, chars: number): Promise<void> => ipcRenderer.invoke(IPC.TERMINAL_ACK, id, chars),
    close: (id: string): Promise<void> => ipcRenderer.invoke(IPC.TERMINAL_CLOSE, id),
    /** True while a terminal has focus, so file commands give up their keys. */
    setFocus: (focused: boolean): Promise<void> => ipcRenderer.invoke(IPC.TERMINAL_SET_FOCUS, focused),
    /** Returns an unsubscribe function. The listener receives the payload only. */
    onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload)
      ipcRenderer.on(IPC_EVENTS.TERMINAL_DATA, forward)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TERMINAL_DATA, forward)
      }
    },
    /** Returns an unsubscribe function. */
    onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, payload: TerminalExitEvent): void => listener(payload)
      ipcRenderer.on(IPC_EVENTS.TERMINAL_EXIT, forward)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TERMINAL_EXIT, forward)
      }
    }
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
