/**
 * Every IPC channel the application exposes.
 *
 * Channels are declared in one place so the preload allowlist, the main-process
 * handlers, and the renderer stay in sync. Nothing may be invoked from the
 * renderer unless it appears here AND is explicitly bridged in preload.ts.
 */
export const IPC = {
  SYSTEM_GET_VERSION: 'system:get-version',
  LOCAL_GET_HOME_DIRECTORY: 'local:get-home-directory',
  LOCAL_LIST_DIRECTORY: 'local:list-directory',
  SFTP_CONNECT: 'sftp:connect',
  SFTP_TRUST_HOST_KEY_AND_CONNECT: 'sftp:trust-host-key-and-connect',
  SFTP_FORGET_HOST_KEY: 'sftp:forget-host-key',
  SFTP_LIST_DIRECTORY: 'sftp:list-directory',
  SFTP_DISCONNECT: 'sftp:disconnect'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * Events the main process pushes to the renderer. Kept apart from IPC so a
 * handler can never be registered on one by mistake.
 */
export const IPC_EVENTS = {
  SFTP_CONNECTION_CLOSED: 'sftp:connection-closed'
} as const
