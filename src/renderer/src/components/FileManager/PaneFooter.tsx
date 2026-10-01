import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatSize, typeLabel } from '@renderer/utils/file-entries'

interface PaneFooterProps {
  /** How many items are listed: fewer than `total` while a search narrows them. */
  count: number | null
  total: number
  selected: FileEntry[]
}

function describeSelection(selected: FileEntry[]): string {
  const [only] = selected
  if (only === undefined) return ''
  if (selected.length === 1) return `${only.name} · ${only.kind === 'file' ? formatSize(only.size) : typeLabel(only)}`
  const files = selected.filter((entry) => entry.kind === 'file')
  const bytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  return files.length === 0 ? `${selected.length} selected` : `${selected.length} selected · ${formatSize(bytes)}`
}

/** One pane's own status: how many items, and what is selected. */
export function PaneFooter({ count, total, selected }: PaneFooterProps): JSX.Element {
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
    </div>
  )
}
