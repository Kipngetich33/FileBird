import type { FileEntry, FileKind } from '@shared/types/files'

/**
 * Dragging rows between panes (Milestone 9). The payload travels in the
 * DataTransfer under a Fly-specific type that names the source side: during
 * dragover only the types can be read, so a pane can tell "from the other pane"
 * before the drop. Anything else (text, files from Finder) has no Fly type.
 */

export type DragSide = 'local' | 'remote'

export type DraggedEntry = Pick<FileEntry, 'name' | 'path' | 'kind'>

const PREFIX = 'application/x-fly-entries+'
const KINDS: readonly FileKind[] = ['file', 'directory', 'other']
export const MAX_DRAGGED_ENTRIES = 1_000

export const dragType = (side: DragSide): string => `${PREFIX}${side}`

export function encodeDrag(entries: readonly FileEntry[]): string {
  return JSON.stringify(entries.map(({ name, path, kind }) => ({ name, path, kind })))
}

/** The side a drag comes from, or null when it isn't exactly one Fly drag. */
export function dragSourceOf(types: readonly string[]): DragSide | null {
  const sides = types.filter((type) => type.startsWith(PREFIX)).map((type) => type.slice(PREFIX.length))
  if (sides.length !== 1) return null
  return sides[0] === 'local' || sides[0] === 'remote' ? sides[0] : null
}

/** Null for anything that isn't a well-formed list of entries. */
export function decodeDrag(raw: string): DraggedEntry[] | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DRAGGED_ENTRIES) return null
  const entries: DraggedEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { name, path, kind } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof path !== 'string' || !KINDS.includes(kind as FileKind)) return null
    entries.push({ name, path, kind: kind as FileKind })
  }
  return entries
}
