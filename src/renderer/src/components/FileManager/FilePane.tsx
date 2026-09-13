import { useCallback, useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import type { FileEntry } from '@shared/types/files'
import type { DirectoryState } from '@renderer/hooks/useDirectory'
import { PaneHeader } from './PaneHeader'
import { FileTable } from './FileTable'

interface FilePaneProps {
  title: string
  subtitle?: string
  directory: DirectoryState
  /** Extra header controls, e.g. Disconnect on the remote pane. */
  actions?: ReactNode
}

/**
 * One file browser pane: toolbar, path, and listing.
 *
 * Keyboard (spec section 14): ↑/↓ select, Enter opens, Backspace goes to the
 * parent folder, F5 refreshes. Delete and F2 arrive with file operations (M8).
 */
export function FilePane({ title, subtitle, directory, actions }: FilePaneProps): JSX.Element {
  const { listing, entries, selectedPath, loading, error, canGoBack } = directory
  const { open, goUp, goBack, refresh, select, dismissError } = directory
  const paneRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => paneRef.current?.focus(), [])

  // Keep the selected row in view as the keyboard moves it.
  useEffect(() => {
    if (selectedPath === null) return
    scrollRef.current
      ?.querySelector(`[data-path="${CSS.escape(selectedPath)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedPath, entries])

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.kind === 'directory') void open(entry.path)
    },
    [open]
  )

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // Let focused toolbar buttons handle their own activation keys.
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
      return
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (entries.length === 0) return
        const step = event.key === 'ArrowDown' ? 1 : -1
        const current = entries.findIndex((entry) => entry.path === selectedPath)
        const next =
          current === -1
            ? step === 1
              ? 0
              : entries.length - 1
            : Math.min(entries.length - 1, Math.max(0, current + step))
        select(entries[next]?.path ?? null)
        return
      }
      case 'Enter': {
        event.preventDefault()
        const entry = entries.find((candidate) => candidate.path === selectedPath)
        if (entry !== undefined) openEntry(entry)
        return
      }
      case 'Backspace':
        event.preventDefault()
        void goUp()
        return
      case 'F5':
        event.preventDefault()
        void refresh()
        return
    }
  }

  return (
    <section
      ref={paneRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${title} files`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-[#11141b] outline-none focus-within:border-white/[0.14]"
    >
      <PaneHeader
        title={title}
        subtitle={subtitle}
        actions={actions}
        path={listing?.path ?? null}
        loading={loading}
        canGoBack={canGoBack}
        canGoUp={listing?.parentPath != null}
        onBack={() => void goBack()}
        onUp={() => void goUp()}
        onRefresh={() => void refresh()}
      />

      {error !== null && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-3 border-b border-red-500/15 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300"
        >
          <span className="select-text">{error.message}</span>
          <button
            type="button"
            onClick={dismissError}
            className="shrink-0 text-[11px] text-red-300/70 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {listing !== null && (
          <FileTable
            entries={entries}
            selectedPath={selectedPath}
            onSelect={select}
            onOpen={openEntry}
          />
        )}
        {listing !== null && entries.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-zinc-600">This folder is empty.</p>
        )}
      </div>
    </section>
  )
}
