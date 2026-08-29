import type { FlyApi } from './preload'

declare global {
  interface Window {
    readonly api: FlyApi
  }
}

export {}
