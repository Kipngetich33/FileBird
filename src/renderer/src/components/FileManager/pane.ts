export type PaneId = 'local' | 'remote'

/** What the page can ask of a pane: used for menu commands and switching panes. */
export interface PaneHandle {
  focus: () => void
  refresh: () => void
  goBack: () => void
  goUp: () => void
}
