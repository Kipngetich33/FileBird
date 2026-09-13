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
}
