/**
 * Multi-selection in a file list (Milestone 7 plan D7), as desktop file
 * managers do it: click replaces, Cmd/Ctrl-click toggles, Shift-click selects
 * the range from the anchor. Pure, over the list's display order.
 */

export interface Selection {
  /** Selected paths, in display order. */
  paths: readonly string[]
  /** The row keyboard moves start from, and Enter opens. */
  cursor: string | null
  /** Where a Shift range starts. */
  anchor: string | null
}

export type SelectMode = 'replace' | 'toggle' | 'range'

export const EMPTY_SELECTION: Selection = { paths: [], cursor: null, anchor: null }

const inOrder = (order: readonly string[], paths: ReadonlySet<string>): string[] => order.filter((path) => paths.has(path))

export function applySelect(selection: Selection, order: readonly string[], path: string | null, mode: SelectMode = 'replace'): Selection {
  if (path === null) return EMPTY_SELECTION
  switch (mode) {
    case 'replace':
      return { paths: [path], cursor: path, anchor: path }
    case 'toggle': {
      const paths = new Set(selection.paths)
      if (paths.has(path)) paths.delete(path)
      else paths.add(path)
      return { paths: inOrder(order, paths), cursor: path, anchor: path }
    }
    case 'range': {
      const anchor = selection.anchor ?? selection.cursor ?? path
      const from = order.indexOf(anchor)
      const to = order.indexOf(path)
      if (from === -1 || to === -1) return { paths: [path], cursor: path, anchor: path }
      const [start, end] = from <= to ? [from, to] : [to, from]
      return { paths: order.slice(start, end + 1), cursor: path, anchor }
    }
  }
}

export function selectAll(selection: Selection, order: readonly string[]): Selection {
  if (order.length === 0) return EMPTY_SELECTION
  return { paths: [...order], cursor: selection.cursor ?? order[0] ?? null, anchor: order[0] ?? null }
}

/** Drops paths that are no longer listed, e.g. after a refresh. Returns the same object when nothing changed. */
export function pruneSelection(selection: Selection, order: readonly string[]): Selection {
  const listed = new Set(order)
  const paths = selection.paths.filter((path) => listed.has(path))
  const cursor = selection.cursor !== null && listed.has(selection.cursor) ? selection.cursor : null
  const anchor = selection.anchor !== null && listed.has(selection.anchor) ? selection.anchor : null
  if (paths.length === selection.paths.length && cursor === selection.cursor && anchor === selection.anchor) return selection
  return { paths, cursor, anchor }
}
