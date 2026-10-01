import type { DirectoryListing } from '@shared/types/files'
import type { DirectorySource } from '@renderer/hooks/useDirectory'
import { toAppError } from './errors'

/** Renderer-side wrapper around the bridged local filesystem API. */
export const localFilesService = {
  async getStartDirectory(): Promise<string> {
    try {
      return await window.api.local.getStartDirectory()
    } catch (error) {
      throw toAppError(error)
    }
  },

  /** Where a download goes when it wasn't dragged to a folder. */
  async getDownloadFolder(): Promise<string> {
    try {
      return await window.api.local.getDownloadFolder()
    } catch (error) {
      throw toAppError(error)
    }
  },

  async listDirectory(path: string): Promise<DirectoryListing> {
    try {
      return await window.api.local.listDirectory(path)
    } catch (error) {
      throw toAppError(error)
    }
  }
} satisfies DirectorySource & { getDownloadFolder: () => Promise<string> }
