import { IPC } from '../../shared/constants/channels'
import type { DirectoryListing } from '../../shared/types/files'
import { listDirectory } from '../services/local-files.service'
import { handle } from './handle'
import { assertAbsolutePath } from './validate'

/** Local file browsing (Milestone 2). Read-only: metadata crosses IPC, contents never do. */
export function registerLocalFilesIpc(startDirectory: string): void {
  handle<string>(IPC.LOCAL_GET_START_DIRECTORY, () => startDirectory)

  handle<DirectoryListing>(IPC.LOCAL_LIST_DIRECTORY, (rawPath) =>
    listDirectory(assertAbsolutePath(rawPath, 'path'))
  )
}
