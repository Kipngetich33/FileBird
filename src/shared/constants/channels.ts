/**
 * Every IPC channel the application exposes.
 *
 * Channels are declared in one place so the preload allowlist, the main-process
 * handlers, and the renderer stay in sync. Nothing may be invoked from the
 * renderer unless it appears here AND is explicitly bridged in preload.ts.
 */
export const IPC = {
  SYSTEM_GET_VERSION: 'system:get-version',
  SYSTEM_PING: 'system:ping'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
