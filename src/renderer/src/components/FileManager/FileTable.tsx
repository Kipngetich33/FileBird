import { memo, type DragEvent, type JSX, type MouseEvent } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatModified, formatSize, shortDateFormat, typeLabel } from '@renderer/utils/file-entries'
import type { SelectMode } from '@renderer/utils/selection'
import { EntryIcon } from './EntryIcon'

/**
 * Columns adapt to the pane, not the window: two panes side by side at the
 * minimum window width leave each about 29rem. Below 42rem the Type column is
 * dropped and dates lose their time.
 */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_5rem_5.5rem] @2xl:grid-cols-[minmax(0,1fr)_7.5rem_6rem_11rem] items-center gap-3 px-3'

interface FileTableProps {
  entries: FileEntry[]
  selectedPaths: ReadonlySet<string>
  /** The keyboard cursor row. */
  cursorPath: string | null
  /** The folder being opened, marked while its listing is on its way. */
  loadingPath?: string | null
  /** An inactive pane shows its selection muted, so only one pane looks "live". */
  active: boolean
  onSelect: (path: string, mode: SelectMode) => void
  onOpen: (entry: FileEntry) => void
  /** Rows can be dragged to the other pane (Milestone 9). */
  onDragStart?: (entry: FileEntry, event: DragEvent) => void
  /** Right-clicking a row. */
  onContextMenu?: (entry: FileEntry) => void
  /** The folder row a drag from the other pane is over. */
  dropTargetPath?: string | null
}

/** Shift-click extends from the anchor; Cmd-click (Ctrl on Windows and Linux) toggles. */
const modeOf = (event: MouseEvent): SelectMode =>
  event.shiftKey ? 'range' : (navigator.platform.startsWith('Mac') ? event.metaKey : event.ctrlKey) ? 'toggle' : 'replace'

export function FileTable({
  entries,
  selectedPaths,
  cursorPath,
  loadingPath = null,
  active,
  onSelect,
  onOpen,
  onDragStart,
  onContextMenu,
  dropTargetPath = null
}: FileTableProps): JSX.Element {
  const multiple = selectedPaths.size > 1
  return (
    <div role="grid" aria-label="Files" aria-multiselectable="true" className="@container min-w-0">
      <div
        role="row"
        className={`${COLUMNS} sticky top-0 z-10 h-7 border-b border-white/[0.06] bg-[#11141b] text-[10px] font-medium tracking-wide text-zinc-500 uppercase`}
      >
        <span role="columnheader">Name</span>
        <span role="columnheader" className="hidden @2xl:block">
          Type
        </span>
        <span role="columnheader" className="text-right">
          Size
        </span>
        <span role="columnheader">Modified</span>
      </div>

      {entries.map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          selected={selectedPaths.has(entry.path)}
          cursor={multiple && entry.path === cursorPath}
          dropTarget={entry.path === dropTargetPath}
          loading={entry.path === loadingPath}
          active={active}
          onSelect={onSelect}
          onOpen={onOpen}
          onDragStart={onDragStart}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )
}

interface FileRowProps {
  entry: FileEntry
  selected: boolean
  /** Marks the keyboard cursor within a multi-selection. */
  cursor: boolean
  /** A drag from the other pane would drop into this folder. */
  dropTarget: boolean
  /** This folder is being opened. */
  loading: boolean
  active: boolean
  onSelect: (path: string, mode: SelectMode) => void
  onOpen: (entry: FileEntry) => void
  onDragStart?: (entry: FileEntry, event: DragEvent) => void
  onContextMenu?: (entry: FileEntry) => void
}

// Memoised: moving the selection re-renders the rows that change, not the whole folder.
const FileRow = memo(function FileRow({ entry, selected, cursor, dropTarget, loading, active, onSelect, onOpen, onDragStart, onContextMenu }: FileRowProps): JSX.Element {
  return (
    <div
      role="row"
      aria-selected={selected}
      data-path={entry.path}
      data-kind={entry.kind}
      data-drop-target={dropTarget || undefined}
      aria-busy={loading || undefined}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart === undefined ? undefined : (event) => onDragStart(entry, event)}
      onMouseDown={(event) => {
        // Shift-click would otherwise select the text between rows.
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => {
        const mode = modeOf(event)
        // A plain click opens a folder; Cmd-click and Shift-click still select it.
        if (entry.kind === 'directory' && mode === 'replace') {
          // The second click of a double-click would land in the folder just opened.
          if (event.detail <= 1) onOpen(entry)
          return
        }
        onSelect(entry.path, mode)
      }}
      onContextMenu={
        onContextMenu === undefined
          ? undefined
          : (event) => {
              event.preventDefault()
              onContextMenu(entry)
            }
      }
      className={`${COLUMNS} h-7 ${loading ? 'cursor-progress' : 'cursor-default'} text-[12px] ${
        dropTarget
          ? 'bg-sky-500/30 text-zinc-50 outline outline-1 -outline-offset-1 outline-sky-400/70'
          : selected
          ? active
            ? 'bg-sky-500/20 text-zinc-50'
            : 'bg-white/[0.08] text-zinc-200'
          : 'text-zinc-300 hover:bg-white/[0.03]'
      } ${cursor && active ? 'shadow-[inset_2px_0_0_0_rgb(56_189_248)]' : ''} ${entry.isHidden ? 'opacity-55' : ''}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        <EntryIcon entry={entry} />
        <span className="truncate">{entry.name}</span>
        {loading && (
          // Shown only once the wait is noticeable, so a quick folder doesn't flash it.
          <span data-testid="row-loading" className="reveal-after-delay flex shrink-0 items-center gap-1 text-[11px] text-sky-300">
            <svg viewBox="0 0 16 16" className="h-3 w-3 animate-spin fill-none stroke-current stroke-2 motion-reduce:animate-none" aria-hidden>
              <path d="M14 8a6 6 0 1 1-6-6" strokeLinecap="round" />
            </svg>
            Opening…
          </span>
        )}
      </span>
      <span role="gridcell" className="hidden truncate text-zinc-500 @2xl:block">
        {typeLabel(entry)}
      </span>
      <span role="gridcell" className="text-right text-zinc-500 tabular-nums">
        {formatSize(entry.size)}
      </span>
      <span role="gridcell" className="truncate text-zinc-500 tabular-nums">
        <span className="@2xl:hidden">{formatModified(entry.modifiedAt, shortDateFormat)}</span>
        <span className="hidden @2xl:inline">{formatModified(entry.modifiedAt)}</span>
      </span>
    </div>
  )
})
