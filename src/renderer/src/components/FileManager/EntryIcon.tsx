import type { JSX } from 'react'
import type { FileEntry } from '@shared/types/files'

/** Folder, file, or unknown glyph, with a small arrow badge for symlinks. */
export function EntryIcon({ entry }: { entry: FileEntry }): JSX.Element {
  return (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      {entry.kind === 'directory' ? (
        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-sky-400/85">
          <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.1l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          className={`h-4 w-4 fill-none stroke-[1.2] ${
            entry.kind === 'file' ? 'stroke-zinc-400' : 'stroke-zinc-600'
          }`}
        >
          <path d="M4 1.5h5l3.5 3.5v9.5H4z" />
          <path d="M9 1.5V5h3.5" />
        </svg>
      )}
      {entry.isSymlink && (
        <svg
          viewBox="0 0 10 10"
          className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-sm bg-[#0b0d12] fill-none stroke-zinc-200 stroke-[1.4]"
        >
          <path d="M3 7l4-4M4 3h3v3" />
        </svg>
      )}
    </span>
  )
}
