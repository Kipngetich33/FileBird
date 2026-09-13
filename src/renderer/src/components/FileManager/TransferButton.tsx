import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'

interface TransferButtonProps {
  direction: 'upload' | 'download'
  /** The selected entry; only a file can be transferred for now. */
  entry: FileEntry | null
  /** A transfer is already running, or the other side isn't ready. */
  busy: boolean
  /** Why the button is unavailable, when it isn't about the selection. */
  unavailableReason?: string
  onClick: () => void
}

/** Upload (local pane) or Download (remote pane) for the selected file. */
export function TransferButton({ direction, entry, busy, unavailableReason, onClick }: TransferButtonProps): JSX.Element {
  const label = direction === 'upload' ? 'Upload' : 'Download'
  const reason =
    unavailableReason ??
    (busy
      ? 'Wait for the current transfer to finish'
      : entry === null
        ? `Select a file to ${label.toLowerCase()}`
        : entry.kind !== 'file'
          ? 'Only files can be transferred for now'
          : null)
  const title = reason ?? `${label} ${entry?.name ?? ''} (⌘T)`

  return (
    <button
      type="button"
      disabled={reason !== null}
      onClick={onClick}
      title={title}
      aria-label={reason === null ? `${label} ${entry?.name ?? ''}` : label}
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
