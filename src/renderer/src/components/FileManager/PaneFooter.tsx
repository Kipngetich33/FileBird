import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatSize, typeLabel } from '@renderer/utils/file-entries'
import { DEFAULT_ZOOM, zoomPercent } from '@renderer/utils/zoom'

interface PaneFooterProps {
  /** How many items are listed: fewer than `total` while a search narrows them. */
  count: number | null
  total: number
  selected: FileEntry[]
  /** This pane's zoom level; shown, and offered back, only when it isn't 100%. */
  zoom: number
  onResetZoom: () => void
}

function describeSelection(selected: FileEntry[]): string {
  const [only] = selected
  if (only === undefined) return ''
  if (selected.length === 1) return `${only.name} · ${only.kind === 'file' ? formatSize(only.size) : typeLabel(only)}`
  const files = selected.filter((entry) => entry.kind === 'file')
  const bytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  return files.length === 0 ? `${selected.length} selected` : `${selected.length} selected · ${formatSize(bytes)}`
}

/** One pane's own status: how many items, what is selected, and its zoom. */
export function PaneFooter({ count, total, selected, zoom, onResetZoom }: PaneFooterProps): JSX.Element {
  const all = count === null ? '' : count === 1 ? '1 item' : `${count} items`
  const items = count !== null && count !== total ? `${count} of ${total} items` : all
  const detail = describeSelection(selected)

  return (
    <div
      data-testid="pane-footer"
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] px-3 text-[11px] text-zinc-500"
    >
      <span data-testid="pane-count" className="shrink-0">
        {items}
      </span>
      <span data-testid="pane-selection" className="min-w-0 truncate">
        {detail}
      </span>
      {zoom !== DEFAULT_ZOOM && (
        // The only way back to 100% without the keyboard, the way a browser offers it.
        <button
          type="button"
          data-testid="pane-zoom"
          onClick={onResetZoom}
          title="Back to actual size"
          className="shrink-0 rounded border border-white/10 px-1.5 tabular-nums text-zinc-400 transition hover:border-sky-500/40 hover:text-sky-200"
        >
          {zoomPercent(zoom)}%
        </button>
      )}
    </div>
  )
}
