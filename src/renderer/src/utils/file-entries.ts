import type { FileEntry } from '@shared/types/files'

/**
 * Presentation helpers for directory listings. Pure, so local and remote panes
 * order and label entries identically.
 */

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders first, then natural case-insensitive name order (`file2` before `file10`). */
/**
 * Whether a name matches what was typed in the pane's search box: the letters
 * in order, ignoring case and surrounding spaces, anywhere in the name. An
 * empty search matches everything, so a pane is never mysteriously empty.
 */
export function matchesSearch(name: string, search: string): boolean {
  const wanted = search.trim().toLocaleLowerCase()
  return wanted === '' || name.toLocaleLowerCase().includes(wanted)
}

export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aIsDirectory = a.kind === 'directory'
    if (aIsDirectory !== (b.kind === 'directory')) return aIsDirectory ? -1 : 1
    // Names equal apart from case still need a stable, deterministic order.
    return nameCollator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/** Decimal units (1 KB = 1000 bytes), matching Finder on the primary platform. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`

  let value = bytes / 1000
  let unit = 0
  while (unit < SIZE_UNITS.length - 1 && Math.round(value) >= 1000) {
    value /= 1000
    unit += 1
  }
  const amount = value < 9.95 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${amount} ${SIZE_UNITS[unit]}`
}

const defaultDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

/** Date only, for panes too narrow for the full date and time. */
export const shortDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' })

export function formatModified(epochMs: number | null, format = defaultDateFormat): string {
  return epochMs === null ? '—' : format.format(epochMs)
}

export function typeLabel(entry: FileEntry): string {
  if (entry.kind === 'directory') return 'Folder'
  if (entry.kind === 'other') return entry.isSymlink ? 'Broken link' : 'Other'

  // A leading dot marks a hidden file, not an extension.
  const dot = entry.name.lastIndexOf('.')
  if (dot <= 0 || dot === entry.name.length - 1) return 'File'
  return `${entry.name.slice(dot + 1).toUpperCase()} file`
}
