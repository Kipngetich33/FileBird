/**
 * The divider between the panes: pure maths plus a guarded read and write of
 * the remembered position. Positions are the left pane's share, in percent.
 */

export const DEFAULT_SPLIT = 50
/** Neither pane may be narrower than this. */
export const MIN_PANE_PX = 320
export const LAYOUT_STORAGE_KEY = 'fly.layout.v1'

export interface SplitBounds {
  min: number
  max: number
}

/** The allowed range for a container of this width; a container too small for both minimums allows only 50/50. */
export function splitBounds(availablePx: number, minPanePx = MIN_PANE_PX): SplitBounds {
  if (!Number.isFinite(availablePx) || availablePx <= minPanePx * 2) return { min: DEFAULT_SPLIT, max: DEFAULT_SPLIT }
  const min = (minPanePx / availablePx) * 100
  return { min, max: 100 - min }
}

export function clampSplit(percent: number, availablePx: number, minPanePx = MIN_PANE_PX): number {
  if (!Number.isFinite(percent)) return DEFAULT_SPLIT
  const { min, max } = splitBounds(availablePx, minPanePx)
  return Math.round(Math.min(max, Math.max(min, percent)) * 10) / 10
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

/** The remembered position, or the default for anything missing or malformed. Never throws. */
export function readStoredSplit(storage: ReadableStorage | null): number {
  try {
    const raw = storage?.getItem(LAYOUT_STORAGE_KEY)
    if (raw === null || raw === undefined) return DEFAULT_SPLIT
    const split = (JSON.parse(raw) as { split?: unknown } | null)?.split
    return typeof split === 'number' && Number.isFinite(split) && split > 0 && split < 100 ? split : DEFAULT_SPLIT
  } catch {
    return DEFAULT_SPLIT
  }
}

/** Best effort: a full or unavailable storage only means the position isn't remembered. */
export function storeSplit(storage: WritableStorage | null, percent: number): void {
  try {
    storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ split: percent }))
  } catch {
    // Not remembering a divider position is harmless.
  }
}

/** localStorage, or null where the browser refuses access to it. */
export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
