import { memo, type JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { formatModified, formatSize, typeLabel } from '@renderer/utils/file-entries'
import { EntryIcon } from './EntryIcon'

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_7.5rem_6rem_11rem] items-center gap-3 px-3'

interface FileTableProps {
  entries: FileEntry[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
}

export function FileTable({ entries, selectedPath, onSelect, onOpen }: FileTableProps): JSX.Element {
  return (
    <div role="grid" aria-label="Files" className="min-w-0">
      <div
        role="row"
        className={`${COLUMNS} sticky top-0 z-10 h-7 border-b border-white/[0.06] bg-[#11141b] text-[10px] font-medium tracking-wide text-zinc-500 uppercase`}
      >
        <span role="columnheader">Name</span>
        <span role="columnheader">Type</span>
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
  onSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
}

// Memoised: moving the selection re-renders two rows, not the whole folder.
const FileRow = memo(function FileRow({ entry, selected, onSelect, onOpen }: FileRowProps): JSX.Element {
  return (
    <div
      role="row"
      aria-selected={selected}
      data-path={entry.path}
      data-kind={entry.kind}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onOpen(entry)}
      className={`${COLUMNS} h-7 cursor-default text-[12px] ${
        selected ? 'bg-sky-500/20 text-zinc-50' : 'text-zinc-300 hover:bg-white/[0.03]'
      } ${entry.isHidden ? 'opacity-55' : ''}`}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        <EntryIcon entry={entry} />
        <span className="truncate">{entry.name}</span>
      </span>
      <span role="gridcell" className="truncate text-zinc-500">
        {typeLabel(entry)}
      </span>
      <span role="gridcell" className="text-right text-zinc-500 tabular-nums">
        {formatSize(entry.size)}
      </span>
      <span role="gridcell" className="truncate text-zinc-500 tabular-nums">
        {formatModified(entry.modifiedAt)}
      </span>
    </div>
  )
})
