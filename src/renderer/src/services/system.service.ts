import type { SystemVersions } from '@shared/types/system'
import { toAppError } from './errors'

/**
 * Renderer-side wrapper around the bridged system API.
 *
 * Components talk to this service rather than touching `window.api` directly,
 * so error normalisation lives in one place and the bridge stays swappable
 * for tests.
 */
export const systemService = {
  async getVersions(): Promise<SystemVersions> {
    try {
      return await window.api.system.getVersion()
    } catch (error) {
      throw toAppError(error)
    }
  },

  /** Shows a file on this computer in Finder or the file manager. */
  async revealInFolder(path: string): Promise<void> {
    try {
      await window.api.system.revealInFolder(path)
    } catch (error) {
      throw toAppError(error)
    }
  }
}
