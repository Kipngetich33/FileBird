import type { BridgeXApi } from './preload'

declare global {
  interface Window {
    readonly api: BridgeXApi
  }
}

export {}
