/**
 * What a directory listing looks like on either side of the connection.
 *
 * Local listings produce these today; the SFTP provider (Milestone 3) maps
 * remote attributes into the same shape, so one pane component serves both.
 */
export type FileKind = 'directory' | 'file' | 'other'

export interface FileEntry {
  name: string
  /** Absolute path, built by the main process. The renderer never joins paths. */
  path: string
  /** For a symlink this is the target's kind; a broken link is 'other'. */
  kind: FileKind
  isSymlink: boolean
  /** Dotfile. */
  isHidden: boolean
  /** Bytes. Null for directories, or when the entry could not be stat'ed. */
  size: number | null
  /** Epoch milliseconds. Null when the entry could not be stat'ed. */
  modifiedAt: number | null
}

export interface DirectoryListing {
  /** Normalised absolute path that was listed. */
  path: string
  /** Null at the filesystem root. */
  parentPath: string | null
  entries: FileEntry[]
}
