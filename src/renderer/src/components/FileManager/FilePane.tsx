import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import type { FileEntry } from '@shared/types/files'
import type { DirectoryState } from '@renderer/hooks/useDirectory'
import { PaneHeader } from './PaneHeader'
import { PaneFooter } from './PaneFooter'
import { FileTable } from './FileTable'
import type { PaneHandle } from './pane'

interface FilePaneProps {
  title: string
  subtitle?: string
  directory: DirectoryState
  /** Whether this is the pane menu commands act on. */
  active: boolean
  /** Called whenever focus enters the pane. */
  onActivate: () => void
  /** Tab / Shift+Tab from the listing. */
  onSwitchPane: () => void
  ref?: Ref<PaneHandle>
  /** Extra header controls, e.g. Disconnect on the remote pane. */
  actions?: ReactNode
  /** A non-fatal message, such as a secret that couldn't be saved. */
  notice?: string | null
  onDismissNotice?: () => void
}

/**
 * One file browser pane: toolbar, path, listing and its own status footer.
 *
 * Keyboard (spec section 14): ↑/↓ select, Enter opens, Backspace goes to the
 * parent folder, F5 refreshes, Tab switches to the other pane. Delete and F2
 * arrive with file operations (M8).
 */
export function FilePane({
  title,
  subtitle,
  directory,
  active,
  onActivate,
  onSwitchPane,
  ref,
  actions,
  notice,
  onDismissNotice
}: FilePaneProps): JSX.Element {
  const { listing, entries, selectedPath, selectedPaths, selectedEntries, loading, error, canGoBack } = directory
  const { open, goUp, goBack, refresh, select, selectAll, dismissError } = directory
  const paneRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => paneRef.current?.focus(), [])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => paneRef.current?.focus(),
      refresh: () => void refresh(),
      goBack: () => void goBack(),
      goUp: () => void goUp(),
      currentPath: () => listing?.path ?? null,
      selectedEntries: () => selectedEntries,
      selectAll,
      refreshIfShowing: (path) => {
        if (listing?.path === path) void refresh()
      }
    }),
    [refresh, goBack, goUp, listing, selectedEntries, selectAll]
  )

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
    // Tab from the listing itself switches panes; from toolbar buttons it stays
    // ordinary tabbing, so every control remains reachable by keyboard.
    if (event.key === 'Tab') {
      if (event.target === paneRef.current) {
        event.preventDefault()
        onSwitchPane()
      }
      return
    }

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
        select(entries[next]?.path ?? null, event.shiftKey ? 'range' : 'replace')
        return
      }
      case 'a':
      case 'A':
        // Usually arrives as the Edit menu's Select All command; handled here too.
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          selectAll()
        }
        return
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
      onFocus={onActivate}
      aria-label={`${title} files`}
      data-active={active}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-[#11141b] outline-none transition-colors ${
        active ? 'border-sky-500/35' : 'border-white/[0.07]'
      }`}
    >
      <PaneHeader
        title={title}
        subtitle={subtitle}
        active={active}
        actions={actions}
        path={listing?.path ?? null}
        loading={loading}
        canGoBack={canGoBack}
        canGoUp={listing?.parentPath != null}
        onBack={() => void goBack()}
        onUp={() => void goUp()}
        onRefresh={() => void refresh()}
      />

      {notice !== undefined && notice !== null && (
        <div
          role="status"
          className="flex shrink-0 items-start justify-between gap-3 border-b border-amber-500/15 bg-amber-500/[0.07] px-3 py-2 text-[12px] text-amber-200"
        >
          <span className="select-text">{notice}</span>
          {onDismissNotice !== undefined && (
            <button type="button" onClick={onDismissNotice} className="shrink-0 text-[11px] text-amber-200/70 hover:text-amber-100">
              Dismiss
            </button>
          )}
        </div>
      )}

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
            selectedPaths={selectedPaths}
            cursorPath={selectedPath}
            active={active}
            onSelect={select}
            onOpen={openEntry}
          />
        )}
        {listing !== null && entries.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-zinc-600">This folder is empty.</p>
        )}
      </div>

      <PaneFooter count={listing === null ? null : entries.length} selected={selectedEntries} />
    </section>
  )
}
