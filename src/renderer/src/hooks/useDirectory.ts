import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { DirectoryListing, FileEntry } from '@shared/types/files'
import { matchesSearch, sortEntries } from '@renderer/utils/file-entries'
import { EMPTY_SELECTION, applySelect, pruneSelection, selectAll, type SelectMode, type Selection } from '@renderer/utils/selection'

/** Where a pane's listings come from. Local today; remote plugs in at Milestone 5. */
export interface DirectorySource {
  getStartDirectory(): Promise<string>
  listDirectory(path: string): Promise<DirectoryListing>
}

export interface DirectoryState {
  listing: DirectoryListing | null
  /** The listing's entries in display order, and only those the search matches. */
  entries: FileEntry[]
  /** What the pane's search box holds; empty shows the whole folder. */
  search: string
  setSearch: (search: string) => void
  /** How many entries the folder has, before the search narrowed them. */
  totalCount: number
  /** The cursor row: where keyboard moves start and what Enter opens. */
  selectedPath: string | null
  selectedPaths: ReadonlySet<string>
  /** Selected entries in display order. */
  selectedEntries: FileEntry[]
  loading: boolean
  /** The folder whose listing is on its way, so the pane can mark it; null when none is. */
  loadingPath: string | null
  error: AppErrorPayload | null
  canGoBack: boolean
  open: (path: string) => Promise<void>
  goUp: () => Promise<void>
  goBack: () => Promise<void>
  refresh: () => Promise<void>
  select: (path: string | null, mode?: SelectMode) => void
  selectAll: () => void
  dismissError: () => void
}

/**
 * Browsing state for one pane (spec section 16: plain hooks, no Context yet).
 *
 * A failed navigation leaves the current listing in place and reports the
 * error, the way a desktop file manager refuses to open a folder rather than
 * blanking the window. `source` must be a stable reference.
 */
export function useDirectory(source: DirectorySource): DirectoryState {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [rawSelection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [error, setError] = useState<AppErrorPayload | null>(null)

  // Only the most recent request may update state, so a slow listing of one
  // folder can never overwrite a newer listing of another.
  const latestRequest = useRef(0)
  /** The path of the request in flight, read synchronously so repeated clicks see it at once. */
  const pathInFlight = useRef<string | null>(null)

  const load = useCallback(
    async (path: string): Promise<DirectoryListing | null> => {
      const request = ++latestRequest.current
      pathInFlight.current = path
      setLoading(true)
      setLoadingPath(path)
      try {
        const next = await source.listDirectory(path)
        if (request !== latestRequest.current) return null
        setListing(next)
        setError(null)
        return next
      } catch (cause) {
        if (request === latestRequest.current) setError(cause as AppErrorPayload)
        return null
      } finally {
        if (request === latestRequest.current) {
          pathInFlight.current = null
          setLoading(false)
          setLoadingPath(null)
        }
      }
    },
    [source]
  )

  useEffect(() => {
    source
      .getStartDirectory()
      .then(load)
      .catch((cause: AppErrorPayload) => {
        setError(cause)
        setLoading(false)
      })
  }, [source, load])

  const currentPath = listing?.path ?? null

  const open = useCallback(
    async (path: string) => {
      // Clicking a folder again while it is still loading must not start over:
      // each new request would throw the one already on its way.
      if (pathInFlight.current === path) return
      const next = await load(path)
      if (next === null) return
      if (currentPath !== null && currentPath !== next.path) {
        setHistory((previous) => [...previous, currentPath])
      }
      setSearch('')
      setSelection(EMPTY_SELECTION)
    },
    [load, currentPath]
  )

  const goUp = useCallback(async () => {
    const parentPath = listing?.parentPath ?? null
    if (parentPath === null || currentPath === null) return
    const next = await load(parentPath)
    if (next === null) return
    setSearch('')
    setHistory((previous) => [...previous, currentPath])
    // Land on the folder we just left, as Finder and Explorer do.
    setSelection(applySelect(EMPTY_SELECTION, [], currentPath))
  }, [load, listing, currentPath])

  const goBack = useCallback(async () => {
    const target = history.at(-1)
    if (target === undefined) return
    // Drop the entry up front: if that folder has since vanished, the user
    // must not be stuck pressing Back on it forever.
    setHistory((previous) => previous.slice(0, -1))
    const next = await load(target)
    if (next !== null) setSearch('')
    if (next !== null) setSelection(currentPath === null ? EMPTY_SELECTION : applySelect(EMPTY_SELECTION, [], currentPath))
  }, [load, history, currentPath])

  const refresh = useCallback(async () => {
    if (currentPath !== null) await load(currentPath)
  }, [load, currentPath])

  const sorted = useMemo(() => (listing === null ? [] : sortEntries(listing.entries)), [listing])
  // Only what the search matches is listed, so anything hidden can't be acted
  // on by mistake: the selection below is pruned to what is on screen.
  const entries = useMemo(() => (search.trim() === '' ? sorted : sorted.filter((entry) => matchesSearch(entry.name, search))), [sorted, search])
  const order = useMemo(() => entries.map((entry) => entry.path), [entries])
  // A refresh can remove selected rows; the selection only ever shows listed ones.
  const selection = useMemo(() => pruneSelection(rawSelection, order), [rawSelection, order])
  const selectedPaths = useMemo(() => new Set(selection.paths), [selection])
  const selectedEntries = useMemo(() => entries.filter((entry) => selectedPaths.has(entry.path)), [entries, selectedPaths])

  const select = useCallback(
    (path: string | null, mode: SelectMode = 'replace') => setSelection((current) => applySelect(pruneSelection(current, order), order, path, mode)),
    [order]
  )

  return {
    listing,
    entries,
    search,
    setSearch,
    totalCount: sorted.length,
    selectedPath: selection.cursor,
    selectedPaths,
    selectedEntries,
    loading,
    loadingPath,
    error,
    canGoBack: history.length > 0,
    open,
    goUp,
    goBack,
    refresh,
    select,
    selectAll: useCallback(() => setSelection((current) => selectAll(current, order)), [order]),
    dismissError: useCallback(() => setError(null), [])
  }
}
