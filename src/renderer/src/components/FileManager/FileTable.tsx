import { memo, type JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatModified, formatSize, shortDateFormat, typeLabel } from '@renderer/utils/file-entries'
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
  selectedPath: string | null
  /** An inactive pane shows its selection muted, so only one pane looks "live". */
  active: boolean
  onSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
}

export function FileTable({ entries, selectedPath, active, onSelect, onOpen }: FileTableProps): JSX.Element {
  return (
    <div role="grid" aria-label="Files" className="@container min-w-0">
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
          selected={entry.path === selectedPath}
          active={active}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

interface FileRowProps {
  entry: FileEntry
  selected: boolean
  active: boolean
  onSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
}

// Memoised: moving the selection re-renders two rows, not the whole folder.
const FileRow = memo(function FileRow({ entry, selected, active, onSelect, onOpen }: FileRowProps): JSX.Element {
  return (
    <div
      role="row"
      aria-selected={selected}
      data-path={entry.path}
      data-kind={entry.kind}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onOpen(entry)}
      className={`${COLUMNS} h-7 cursor-default text-[12px] ${
        selected
          ? active
            ? 'bg-sky-500/20 text-zinc-50'
            : 'bg-white/[0.08] text-zinc-200'
          : 'text-zinc-300 hover:bg-white/[0.03]'
      } ${entry.isHidden ? 'opacity-55' : ''}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        <EntryIcon entry={entry} />
        <span className="truncate">{entry.name}</span>
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
