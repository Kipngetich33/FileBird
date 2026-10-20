/**
 * Bookkeeping for a pane's terminal tabs (user request, 2026-10-15). Kept pure
 * and apart from the pane, because the interesting part is what happens to the
 * selection when a tab in the middle is closed. Each tab holds a layout tree of
 * one or more shells (`terminal-layout.ts`).
 */

import { maxTerminalsFor } from '@shared/constants/terminals'
import { paneCount, type TerminalNode } from './terminal-layout'

export interface TerminalTab {
  /** Stable for the tab's lifetime: React must not remount a live session. */
  key: string
  /** The panes inside it: one shell, or a tree of them once it has been split. */
  layout: TerminalNode
}

export const terminalKey = (ordinal: number): string => `terminal-${ordinal}`

/** "Terminal", then "Terminal 2": numbered by position, so closing one never leaves a gap. */
export const terminalLabel = (index: number): string => (index === 0 ? 'Terminal' : `Terminal ${index + 1}`)

/** Every shell the pane is running, across all of its tabs. */
export const totalPanes = (tabs: readonly TerminalTab[]): number => tabs.reduce((sum, tab) => sum + paneCount(tab.layout), 0)

export const canAddTerminal = (tabs: readonly TerminalTab[], side: 'local' | 'remote'): boolean =>
  totalPanes(tabs) < maxTerminalsFor(side)

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
