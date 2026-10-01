/**
 * Every IPC channel the application exposes.
 *
 * Channels are declared in one place so the preload allowlist, the main-process
 * handlers, and the renderer stay in sync. Nothing may be invoked from the
 * renderer unless it appears here AND is explicitly bridged in preload.ts.
 */
export const IPC = {
  SYSTEM_GET_VERSION: 'system:get-version',
  SYSTEM_REVEAL_IN_FOLDER: 'system:reveal-in-folder',
  APP_SHOW_CONTEXT_MENU: 'app:show-context-menu',
  LOCAL_GET_START_DIRECTORY: 'local:get-start-directory',
  LOCAL_GET_DOWNLOAD_FOLDER: 'local:get-download-folder',
  LOCAL_LIST_DIRECTORY: 'local:list-directory',
  SFTP_TRUST_HOST_KEY_AND_CONNECT: 'sftp:trust-host-key-and-connect',
  SFTP_FORGET_HOST_KEY: 'sftp:forget-host-key',
  SFTP_LIST_DIRECTORY: 'sftp:list-directory',
  SFTP_DISCONNECT: 'sftp:disconnect',
  CONNECTIONS_LIST: 'connections:list',
  CONNECTIONS_CREATE: 'connections:create',
  CONNECTIONS_UPDATE: 'connections:update',
  CONNECTIONS_DELETE: 'connections:delete',
  CONNECTIONS_FORGET_SECRET: 'connections:forget-secret',
  CONNECTIONS_CONNECT: 'connections:connect',
  CONNECTIONS_CONNECT_UNSAVED: 'connections:connect-unsaved',
  KEYS_PICK: 'keys:pick',
  KEYS_INSPECT: 'keys:inspect',
  SSH_CONFIG_PREVIEW: 'ssh-config:preview',
  SSH_CONFIG_IMPORT: 'ssh-config:import',
  TRANSFERS_START: 'transfers:start',
  TRANSFERS_CANCEL: 'transfers:cancel',
  TRANSFERS_CANCEL_ALL: 'transfers:cancel-all',
  TRANSFERS_RETRY: 'transfers:retry',
  TRANSFERS_RETRY_FAILED: 'transfers:retry-failed',
  TRANSFERS_CLEAR_FINISHED: 'transfers:clear-finished',
  TRANSFERS_LIST: 'transfers:list',
  FILES_CREATE_FOLDER: 'files:create-folder',
  FILES_RENAME: 'files:rename',
  FILES_DELETE: 'files:delete',
  FILES_MOVE: 'files:move',
  TERMINAL_OPEN: 'terminal:open',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_ACK: 'terminal:ack',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_SET_FOCUS: 'terminal:set-focus'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * Events the main process pushes to the renderer. Kept apart from IPC so a
 * handler can never be registered on one by mistake.
 */
export const IPC_EVENTS = {
  SFTP_CONNECTION_CLOSED: 'sftp:connection-closed',
  MENU_COMMAND: 'app:menu-command',
  TRANSFER_UPDATE: 'transfers:update',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit'
} as const
