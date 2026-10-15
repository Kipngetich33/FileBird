/**
 * Bookkeeping for a pane's terminal tabs (user request, 2026-10-15). Kept pure
 * and apart from the pane, because the interesting part is what happens to the
 * selection when a tab in the middle is closed.
 */

import { MAX_TERMINALS_PER_PANE } from '@shared/constants/terminals'

export interface TerminalTab {
  /** Stable for the tab's lifetime: React must not remount a live session. */
  key: string
  /** The folder it was started in. Each tab keeps its own; the shell moves on its own from there. */
  cwd: string | null
}

export const terminalKey = (ordinal: number): string => `terminal-${ordinal}`

/** "Terminal", then "Terminal 2": numbered by position, so closing one never leaves a gap. */
export const terminalLabel = (index: number): string => (index === 0 ? 'Terminal' : `Terminal ${index + 1}`)

export const canAddTerminal = (tabs: readonly TerminalTab[]): boolean => tabs.length < MAX_TERMINALS_PER_PANE

/**
 * What is left after closing one tab, and which one takes over: the tab to its
 * left if there is one, else the one to its right, as an editor does. Closing a
 * tab that isn't the active one never moves the selection.
 */
export function afterClosing(
  tabs: readonly TerminalTab[],
  closing: string,
  active: string | null
): { tabs: TerminalTab[]; active: string | null } {
  const index = tabs.findIndex((tab) => tab.key === closing)
  const remaining = tabs.filter((tab) => tab.key !== closing)
  if (index === -1) return { tabs: [...tabs], active }
  if (active !== closing) return { tabs: remaining, active: remaining.some((tab) => tab.key === active) ? active : null }
  const neighbour = remaining[Math.max(0, index - 1)]
  return { tabs: remaining, active: neighbour?.key ?? null }
}
