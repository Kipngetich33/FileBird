import type { DeleteOutcome, FileTarget } from '@shared/types/file-operations'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Create folder, rename and delete on either side (Milestone 8). */
export const filesService = {
  createFolder: (target: FileTarget, parent: string, name: string): Promise<string> =>
    call(() => window.api.files.createFolder(target, parent, name)),
  rename: (target: FileTarget, path: string, newName: string): Promise<string> =>
    call(() => window.api.files.rename(target, path, newName)),
  remove: (target: FileTarget, paths: string[]): Promise<DeleteOutcome> => call(() => window.api.files.delete(target, paths))
}
