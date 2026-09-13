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
  LOCAL_LIST_DIRECTORY: 'local:list-directory'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
