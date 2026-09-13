import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatSize, typeLabel } from '@renderer/utils/file-entries'

interface PaneFooterProps {
  count: number | null
  selected: FileEntry | null
}

/** One pane's own status: how many items, and what is selected. */
export function PaneFooter({ count, selected }: PaneFooterProps): JSX.Element {
  const items = count === null ? '' : count === 1 ? '1 item' : `${count} items`
  const detail =
    selected === null ? '' : `${selected.name} · ${selected.kind === 'file' ? formatSize(selected.size) : typeLabel(selected)}`

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
