import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'

interface TransferButtonProps {
  direction: 'upload' | 'download'
  /** The selected entries; files and folders can be transferred. */
  entries: FileEntry[]
  /** Why the button is unavailable, when it isn't about the selection. */
  unavailableReason?: string
  /** Where these would land, so a download says where it goes before it goes there. */
  destination?: string | null
  onClick: () => void
}

/** Upload (local pane) or Download (remote pane) for the selection. Transfers queue, so it is never busy. */
export function TransferButton({ direction, entries, unavailableReason, destination, onClick }: TransferButtonProps): JSX.Element {
  const label = direction === 'upload' ? 'Upload' : 'Download'
  const transferable = entries.filter((entry) => entry.kind !== 'other')
  const reason =
    unavailableReason ??
    (entries.length === 0
      ? `Select files or folders to ${label.toLowerCase()}`
      : transferable.length === 0
        ? "Broken links and special files can't be transferred"
        : null)
  const what = transferable.length === 1 ? (transferable[0]?.name ?? '') : `${transferable.length} items`

  return (
    <button
      type="button"
      disabled={reason !== null}
      onClick={onClick}
      title={reason ?? `${label} ${what}${destination ? ` to ${destination}` : ''} (⌘T)`}
      aria-label={reason === null ? `${label} ${what}` : label}
      data-testid={`${direction}-button`}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-sky-500/40 hover:text-sky-200 disabled:pointer-events-none disabled:opacity-35"
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current stroke-[1.7]" aria-hidden>
        {direction === 'upload' ? <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" /> : <path d="M8 3v9.5M3.5 8 8 12.5 12.5 8" />}
      </svg>
      <span className="hidden @lg:inline">{label}</span>
    </button>
  )
}
