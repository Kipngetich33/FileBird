import type { DirectoryListing } from '@shared/types/files'
import type { DirectorySource } from '@renderer/hooks/useDirectory'
import { toAppError } from './errors'

/** Renderer-side wrapper around the bridged local filesystem API. */
export const localFilesService = {
  async getStartDirectory(): Promise<string> {
    try {
      return await window.api.local.getHomeDirectory()
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
} satisfies DirectorySource
