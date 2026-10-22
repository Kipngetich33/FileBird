/**
 * Each pane zooms on its own (user request, 2026-10-15): a fixed ladder of
 * levels, plus a guarded read and write of the remembered one. Pure, so the
 * maths is testable without a pane.
 *
 * The listing is scaled with CSS `zoom`; a terminal instead gets a bigger font,
 * which is what a shell can actually honour (its columns and rows change with
 * it, and the far end is told).
 */

/** Browser-like steps. Levels are exact members of this list, so repeated stepping never drifts. */
export const ZOOM_LEVELS = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const

export const DEFAULT_ZOOM = 1
export const ZOOM_STORAGE_KEY = 'bridgex.zoom.v1'

/** The font size a terminal uses at 100%; every other level is this scaled. */
export const TERMINAL_BASE_FONT_PX = 12

export type ZoomSide = 'local' | 'remote'

/** The nearest allowed level, and the default for anything that isn't a usable number. */
export function snapZoom(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM
  let nearest: number = DEFAULT_ZOOM
  for (const candidate of ZOOM_LEVELS) {
    if (Math.abs(candidate - level) < Math.abs(nearest - level)) nearest = candidate
  }
  return nearest
}

/** One step in (1) or out (-1), stopping at the ends of the ladder. */
export function stepZoom(level: number, direction: 1 | -1): number {
  const index = ZOOM_LEVELS.indexOf(snapZoom(level) as (typeof ZOOM_LEVELS)[number])
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + direction))
  return ZOOM_LEVELS[next] ?? DEFAULT_ZOOM
}

/** What to show the user, e.g. 115 for 1.15. */
export const zoomPercent = (level: number): number => Math.round(snapZoom(level) * 100)

export const terminalFontSize = (level: number): number => Math.round(TERMINAL_BASE_FONT_PX * snapZoom(level))

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The level remembered for one pane, or 100% for anything missing or malformed. Never throws. */
export function readStoredZoom(storage: ReadableStorage | null, side: ZoomSide): number {
  try {
    const raw = storage?.getItem(ZOOM_STORAGE_KEY)
    if (raw === null || raw === undefined) return DEFAULT_ZOOM
    const stored = (JSON.parse(raw) as Partial<Record<ZoomSide, unknown>> | null)?.[side]
    return typeof stored === 'number' ? snapZoom(stored) : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

/** Best effort, and never loses the other pane's level. */
export function storeZoom(storage: WritableStorage | null, side: ZoomSide, level: number): void {
  if (storage === null) return
  try {
    const other: ZoomSide = side === 'local' ? 'remote' : 'local'
    storage.setItem(ZOOM_STORAGE_KEY, JSON.stringify({ [side]: snapZoom(level), [other]: readStoredZoom(storage, other) }))
  } catch {
    // Not remembering a zoom level is harmless.
  }
}
