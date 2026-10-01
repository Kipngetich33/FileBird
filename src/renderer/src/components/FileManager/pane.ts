import type { DeleteOutcome, MoveOutcome } from '@shared/types/file-operations'
import type { FileEntry } from '@shared/types/files'

export type PaneId = 'local' | 'remote'

/** What the page can ask of a pane: menu commands, switching panes and transfers. */
export interface PaneHandle {
  focus: () => void
  refresh: () => void
  goBack: () => void
  goUp: () => void
  /** The folder being shown, or null while none is (loading, or not connected). */
  currentPath: () => string | null
  /** In display order; empty when nothing is selected. */
  selectedEntries: () => FileEntry[]
  selectAll: () => void
  /** Refreshes only if the pane is showing this folder, e.g. after a transfer into it. */
  refreshIfShowing: (path: string) => void
  /** Switches the pane between its files and its terminal (Milestone 11). */
  toggleTerminal: () => void
  /** Opens the pane's search box (Milestone 12). */
  search: () => void
  /** File operations (Milestone 8); each opens its dialog, or does nothing if unavailable. */
  newFolder: () => void
  rename: () => void
  deleteSelection: () => void
}

/** What a pane can do to its files, bound to its side. */
export interface PaneOperations {
  /** Naming rules: this computer's platform locally, POSIX on the server. */
  platform: string
  /** Local deletes go to the Trash (Recycle Bin on Windows); remote deletes are permanent. */
  trash: boolean
  createFolder: (parent: string, name: string) => Promise<string>
  rename: (path: string, newName: string) => Promise<string>
  remove: (paths: string[]) => Promise<DeleteOutcome>
  /** Moves items into a folder on this same side (Milestone 12). */
  move: (paths: string[], destination: string) => Promise<MoveOutcome>
}
