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
