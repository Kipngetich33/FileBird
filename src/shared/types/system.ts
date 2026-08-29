/** Runtime versions reported by the main process. */
export interface SystemVersions {
  app: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
}

/** Result of the round-trip test call used to prove IPC works. */
export interface PingResult {
  /** Echo of the validated message the renderer sent. */
  message: string
  /** ISO timestamp recorded in the main process. */
  receivedAt: string
}
