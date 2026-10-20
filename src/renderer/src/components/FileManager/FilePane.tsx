import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref
} from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { FileEntry } from '@shared/types/files'
import { ConfirmDialog } from '@renderer/components/Connection/ConfirmDialog'
import type { DirectoryState } from '@renderer/hooks/useDirectory'
import { appService } from '@renderer/services/app.service'
import { fileContextMenu } from '@renderer/utils/context-menu'
import { decodeDrag, dragSourceOf, dragType, encodeDrag, type DragSide, type DraggedEntry } from '@renderer/utils/drag'
import { describeDeleteOutcome, listNames } from '@renderer/utils/file-operations'
import { safeLocalStorage } from '@renderer/utils/split'
import { DEFAULT_ZOOM, readStoredZoom, stepZoom, storeZoom, terminalFontSize } from '@renderer/utils/zoom'
import { afterClosing, canAddTerminal, terminalKey, type TerminalTab } from '@renderer/utils/terminal-tabs'
import {
  findPane,
  firstPane,
  leaf,
  neighbourOf,
  paneCount,
  removePane,
  resizeSplit,
  splitPane,
  type SplitDirection
} from '@renderer/utils/terminal-layout'
import { maxTerminalsFor } from '@shared/constants/terminals'
import { TerminalPanes } from '@renderer/components/Terminal/TerminalPanes'
import { NameDialog } from './NameDialog'
import { PaneSearch } from './PaneSearch'
import { PaneTabs, type PaneTab } from './PaneTabs'
import { PaneHeader } from './PaneHeader'
import { PaneFooter } from './PaneFooter'
import { FileTable } from './FileTable'
import type { PaneHandle, PaneOperations } from './pane'

type Operation = { kind: 'new-folder' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entries: FileEntry[] }

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/**
 * Cmd/Ctrl with one of these zooms the pane: in, out, or back to actual size.
 * `+` is the shifted form of `=`, which a menu accelerator can't also carry.
 * Not `_`: Ctrl+_ is readline's undo, and a shell should keep it.
 */
const ZOOM_KEYS: Record<string, 1 | -1 | 0> = { '=': 1, '+': 1, '-': -1, '0': 0 }

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
  /** Create folder, rename and delete for this pane's side; absent for a pane that can't. */
  operations?: PaneOperations
  /** Which side this pane shows; drags carry it so the other pane can accept them. */
  side: DragSide
  /** Rows dragged in from the other pane, dropped into `destination` (Milestone 9). */
  onDropEntries?: (source: DragSide, entries: DraggedEntry[], destination: string) => void
  /** Upload (local) or Download (remote) chosen from the right-click menu. */
  onTransfer?: (entries: FileEntry[]) => void
  /** False while a transfer can't start, e.g. the local pane with no server connected. */
  canTransfer?: boolean
  /** Absent for a pane that can't run a shell, such as the remote pane before it connects. */
  terminal?: { side: 'local' | 'remote'; connectionId?: string }
}

/**
 * One file browser pane: toolbar, path, listing and its own status footer.
 *
 * Mouse: a click opens a folder or selects a file; Cmd-click (Ctrl on Windows
 * and Linux) and Shift-click select; right-click selects the row and shows a
 * menu of what can be done with it.
 *
 * Keyboard (spec section 14): ↑/↓ select (Shift extends), Enter opens,
 * Backspace goes to the parent folder, F5 refreshes, Tab switches to the other
 * pane, F2 renames, Delete (or Cmd+Backspace on macOS) deletes, and
 * Cmd/Ctrl+Shift+N creates a folder.
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
  onDismissNotice,
  operations,
  side,
  onDropEntries,
  onTransfer,
  canTransfer = true,
  terminal
}: FilePaneProps): JSX.Element {
  const { listing, entries, selectedPath, selectedPaths, selectedEntries, loading, loadingPath, error, canGoBack, search, totalCount } = directory
  const { open, goUp, goBack, refresh, select, selectAll, dismissError, setSearch } = directory
  const paneRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => paneRef.current?.focus(), [])

  const [searching, setSearching] = useState(false)
  const [tab, setTab] = useState<PaneTab>('files')
  /**
   * How much this pane's content is scaled (user request, 2026-10-15), each pane
   * on its own and remembered between launches. The listing is scaled with CSS
   * `zoom`, which also narrows it in its own container query, so the Type column
   * steps aside at high zoom instead of squeezing the names. A terminal can't be
   * scaled that way without blurring, so it gets a bigger font instead.
   */
  const [zoom, setZoom] = useState(() => readStoredZoom(safeLocalStorage(), side))
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  /**
   * The pane's terminals (user request, 2026-10-15: more than one, as tabs).
   * Each is created when it is asked for and then stays mounted, hidden, so
   * switching away keeps its session and scrollback. Each freezes the folder it
   * started in: the shell has its own from then on, and following the file list
   * would interrupt whatever is running — which is also why a second terminal
   * is useful, since it can start somewhere else.
   */
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null)
  /** The pane the keyboard is in, which is the one a split or a close acts on. */
  const [focusedPane, setFocusedPane] = useState<string | null>(null)
  const focusedPaneRef = useRef(focusedPane)
  focusedPaneRef.current = focusedPane
  // Read through refs, because opening and closing decide what to do from the
  // current tabs; deciding inside a state updater may be deferred or repeated.
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals
  const activeTerminalRef = useRef(activeTerminal)
  activeTerminalRef.current = activeTerminal
  /** These only ever count up, so a new tab, pane or divider never reuses a closing one's key. */
  const openedTerminals = useRef(0)
  const openedPanes = useRef(0)
  const openedSplits = useRef(0)
  const nextPane = (): string => {
    openedPanes.current += 1
    return `pane-${openedPanes.current}`
  }
  const [operation, setOperation] = useState<Operation | null>(null)
  const [operationBusy, setOperationBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [operationMessage, setOperationMessage] = useState<string | null>(null)
  /** The folder a drag would drop into, while one is over this pane. */
  const [dropDestination, setDropDestination] = useState<string | null>(null)
  /** True while that drop would move items within this pane rather than transfer them. */
  const [dropMoves, setDropMoves] = useState(false)
  /** What a drag that started in this pane is carrying; a drag's data can't be read while it moves. */
  const dragging = useRef<ReadonlySet<string>>(new Set())

  // A drag cancelled or dropped elsewhere must not leave the highlight behind.
  useEffect(() => {
    const clear = (): void => {
      setDropDestination(null)
      dragging.current = new Set()
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  function startDrag(entry: FileEntry, event: DragEvent): void {
    // Dragging a selected row takes the whole selection; any other row becomes the selection.
    const dragged = selectedPaths.has(entry.path) ? selectedEntries : [entry]
    if (!selectedPaths.has(entry.path)) select(entry.path)
    // Remembered for a drop back in this pane: the items decide which folder rows can take them.
    dragging.current = new Set(dragged.map((item) => item.path))
    event.dataTransfer.setData(dragType(side), encodeDrag(dragged))
    event.dataTransfer.effectAllowed = 'copyMove'

    const chip = document.createElement('div')
    chip.textContent = dragged.length === 1 ? (dragged[0]?.name ?? '') : `${dragged.length} items`
    chip.style.cssText =
      'position:fixed;top:-100px;left:0;padding:3px 8px;border-radius:6px;background:#0284c7;color:white;font:12px system-ui;white-space:nowrap'
    document.body.appendChild(chip)
    event.dataTransfer.setDragImage(chip, 12, 12)
    setTimeout(() => chip.remove(), 0)
  }

  /**
   * Where a drag over this pane would land, or null when this pane won't take it.
   *
   * From the other pane: the folder row under the pointer, else the folder on
   * show — that is a transfer. From this pane: a folder row only, and never one
   * of the items being dragged — that is a move within this side (Milestone 12).
   */
  function destinationFor(event: DragEvent): { path: string; moves: boolean } | null {
    const source = dragSourceOf([...event.dataTransfer.types])
    if (listing === null || source === null) return null
    const folderRow = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="row"][data-kind="directory"]') : null

    if (source === side) {
      const folder = folderRow?.dataset.path
      // Dropping items on themselves, or on a folder travelling with them, does nothing.
      if (operations === undefined || folder === undefined || dragging.current.has(folder)) return null
      return { path: folder, moves: true }
    }

    if (onDropEntries === undefined) return null
    return { path: folderRow?.dataset.path ?? listing.path, moves: false }
  }

  function onDragOver(event: DragEvent): void {
    const destination = destinationFor(event)
    if (destination === null) {
      event.dataTransfer.dropEffect = 'none'
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = destination.moves ? 'move' : 'copy'
    if (destination.path !== dropDestination) setDropDestination(destination.path)
    if (destination.moves !== dropMoves) setDropMoves(destination.moves)
  }

  function onDragLeave(event: DragEvent): void {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropDestination(null)
  }

  function onDrop(event: DragEvent): void {
    const destination = destinationFor(event)
    setDropDestination(null)
    const source = dragSourceOf([...event.dataTransfer.types])
    if (destination === null || source === null) return
    event.preventDefault()
    const entries = decodeDrag(event.dataTransfer.getData(dragType(source)))
    if (entries === null) return
    if (destination.moves) void moveInto(entries.map((entry) => entry.path), destination.path)
    else onDropEntries?.(source, entries, destination.path)
  }

  /** A drop inside this pane: move those items into that folder, and say what happened. */
  async function moveInto(paths: string[], destination: string): Promise<void> {
    if (operations === undefined) return
    setOperationMessage(null)
    try {
      const outcome = await operations.move(paths, destination)
      const failure = outcome.failures[0]
      if (failure !== undefined) {
        setOperationMessage(
          outcome.failures.length === 1
            ? `Couldn't move "${failure.name}": ${failure.error.message}`
            : `Couldn't move ${outcome.failures.length} of ${paths.length} items: ${failure.error.message}`
        )
      }
      if (outcome.moved > 0) await refresh()
    } catch (cause) {
      setOperationMessage((cause as AppErrorPayload).message)
    }
  }

  const applyZoom = useCallback(
    (level: number) => {
      setZoom(level)
      storeZoom(safeLocalStorage(), side, level)
    },
    [side]
  )
  // Read through a ref, so a key held down steps from the level on screen.
  const adjustZoom = useCallback((direction: 1 | -1) => applyZoom(stepZoom(zoomRef.current, direction)), [applyZoom])
  const resetZoom = useCallback(() => applyZoom(DEFAULT_ZOOM), [applyZoom])

  /** Opens the search box, or focuses it when it is already open. */
  const startSearch = useCallback(() => {
    setTab('files')
    setSearching(true)
  }, [])

  const endSearch = useCallback(() => {
    setSearching(false)
    setSearch('')
    paneRef.current?.focus()
  }, [setSearch])

  const showFiles = useCallback(() => {
    setTab('files')
    paneRef.current?.focus()
  }, [])

  const atCapMessage = (): void =>
    setOperationMessage(`A pane runs up to ${maxTerminalsFor(side)} terminals at a time, counting splits.`)

  /** Adds a terminal tab and shows it, starting it in the folder on show now. */
  const openTerminal = useCallback(() => {
    if (terminal === undefined) return
    if (!canAddTerminal(terminalsRef.current, side)) {
      atCapMessage()
      return
    }
    openedTerminals.current += 1
    const pane = nextPane()
    const added: TerminalTab = { key: terminalKey(openedTerminals.current), layout: leaf(pane, listing?.path ?? null) }
    setTerminals([...terminalsRef.current, added])
    setActiveTerminal(added.key)
    setFocusedPane(pane)
    setTab('terminal')
  }, [terminal, listing, side])

  /**
   * Divides one named pane, side by side or one above the other (user request,
   * 2026-10-19). Named rather than "the focused one", because the right-click
   * menu acts on the pane under the pointer (user request, 2026-10-20).
   */
  const splitPaneFrom = useCallback(
    (target: string, direction: SplitDirection) => {
      if (terminal === undefined) return
      const tabs = terminalsRef.current
      const current = tabs.find((item) => findPane(item.layout, target) !== null)
      if (current === undefined) return
      if (!canAddTerminal(tabs, side)) {
        atCapMessage()
        return
      }
      const pane = nextPane()
      openedSplits.current += 1
      const layout = splitPane(current.layout, target, leaf(pane, listing?.path ?? null), direction, `split-${openedSplits.current}`)
      setTerminals(tabs.map((item) => (item.key === current.key ? { ...item, layout } : item)))
      setActiveTerminal(current.key)
      setFocusedPane(pane)
      setTab('terminal')
    },
    [terminal, listing, side]
  )

  /** The menu command: it divides the pane the keyboard is in, opening one first if there is none. */
  const splitTerminal = useCallback(
    (direction: SplitDirection) => {
      if (terminal === undefined) return
      const current = terminalsRef.current.find((item) => item.key === activeTerminalRef.current)
      if (current === undefined) {
        openTerminal()
        return
      }
      const focused = focusedPaneRef.current
      const target = focused !== null && findPane(current.layout, focused) !== null ? focused : firstPane(current.layout).key
      splitPaneFrom(target, direction)
    },
    [terminal, openTerminal, splitPaneFrom]
  )

  /**
   * Moves one divider; the other splits keep their own share. A drag fires
   * every pointer move, so tabs whose layout doesn't change keep the object
   * they had and are not re-rendered.
   */
  const resizePane = useCallback((splitId: string, ratio: number) => {
    setTerminals(
      terminalsRef.current.map((item) => {
        const layout = resizeSplit(item.layout, splitId, ratio)
        return layout === item.layout ? item : { ...item, layout }
      })
    )
  }, [])

  /** Shows a terminal that is already open. */
  const showTerminal = useCallback((key: string) => {
    setActiveTerminal(key)
    setTab('terminal')
  }, [])

  /**
   * Closes one terminal: unmounting its view ends that session and nothing else.
   * The tab to its left takes over, and the files come back when it was the last.
   */
  const closeTerminal = useCallback((key: string) => {
    const next = afterClosing(terminalsRef.current, key, activeTerminalRef.current)
    setTerminals(next.tabs)
    setActiveTerminal(next.active)
    if (next.active === null) {
      setTab('files')
      paneRef.current?.focus()
      return
    }
    // A terminal is still on show, so the keyboard belongs to it rather than to
    // the list behind it. When the closed tab was the active one, the tab taking
    // over focuses itself as it becomes visible; when it wasn't, the terminal on
    // show is already in the page and focus is put back on it here, because the
    // button that was clicked has just gone.
    if (next.active === activeTerminalRef.current) {
      paneRef.current?.querySelector<HTMLTextAreaElement>('[data-showing] .xterm-helper-textarea')?.focus()
    }
  }, [])

  /**
   * Closes one pane of a split: the rest of the tab stays, the pane beside it
   * takes the keyboard, and a tab down to its last pane closes with it.
   */
  const closePane = useCallback(
    (pane: string) => {
      const tabs = terminalsRef.current
      const owner = tabs.find((item) => findPane(item.layout, pane) !== null)
      if (owner === undefined) return
      const remaining = removePane(owner.layout, pane)
      if (remaining === null) {
        closeTerminal(owner.key)
        return
      }
      const neighbour = neighbourOf(owner.layout, pane)
      setTerminals(tabs.map((item) => (item.key === owner.key ? { ...item, layout: remaining } : item)))
      if (focusedPaneRef.current === pane) setFocusedPane(neighbour)
      // The pane beside it is already in the page, so the keyboard can go
      // straight back to it rather than falling through to the file list.
      if (neighbour !== null) {
        requestAnimationFrame(() =>
          paneRef.current?.querySelector<HTMLTextAreaElement>(`[data-pane="${CSS.escape(neighbour)}"] .xterm-helper-textarea`)?.focus()
        )
      }
    },
    [closeTerminal]
  )


  /** `Cmd/Ctrl+\``: out of a terminal to the files, or back to the last one — opening one if there is none. */
  const toggleTerminal = useCallback(() => {
    if (tab === 'terminal') {
      showFiles()
      return
    }
    const last = terminals[terminals.length - 1]
    if (activeTerminal !== null && terminals.some((item) => item.key === activeTerminal)) showTerminal(activeTerminal)
    else if (last !== undefined) showTerminal(last.key)
    else openTerminal()
  }, [tab, terminals, activeTerminal, showFiles, showTerminal, openTerminal])

  // Terminals on a connection that has gone away are closed with it.
  useEffect(() => {
    if (terminal === undefined && terminals.length > 0) {
      setTerminals([])
      setActiveTerminal(null)
      setTab('files')
    }
  }, [terminal, terminals.length])

  const startNewFolder = useCallback(() => {
    if (operations === undefined || listing === null) return
    setNameError(null)
    setOperation({ kind: 'new-folder' })
  }, [operations, listing])

  const startRename = useCallback(() => {
    if (operations === undefined) return
    const entry = selectedEntries.length === 1 ? selectedEntries[0] : entries.find((candidate) => candidate.path === selectedPath)
    if (entry === undefined) return
    setNameError(null)
    setOperation({ kind: 'rename', entry })
  }, [operations, selectedEntries, entries, selectedPath])

  const startDelete = useCallback(() => {
    if (operations === undefined || selectedEntries.length === 0) return
    setOperation({ kind: 'delete', entries: selectedEntries })
  }, [operations, selectedEntries])

  const closeOperation = (): void => {
    setOperation(null)
    paneRef.current?.focus()
  }

  async function submitName(name: string): Promise<void> {
    if (operations === undefined || operation === null || operation.kind === 'delete' || listing === null) return
    setOperationBusy(true)
    setNameError(null)
    try {
      const path =
        operation.kind === 'new-folder'
          ? await operations.createFolder(listing.path, name)
          : await operations.rename(operation.entry.path, name)
      closeOperation()
      await refresh()
      select(path)
    } catch (cause) {
      setNameError((cause as AppErrorPayload).message)
    } finally {
      setOperationBusy(false)
    }
  }

  async function confirmDelete(entriesToDelete: FileEntry[]): Promise<void> {
    if (operations === undefined || operationBusy) return
    setOperationBusy(true)
    setOperationMessage(null)
    try {
      const outcome = await operations.remove(entriesToDelete.map((entry) => entry.path))
      setOperationMessage(describeDeleteOutcome(outcome, entriesToDelete.length, operations.trash))
    } catch (cause) {
      setOperationMessage((cause as AppErrorPayload).message)
    } finally {
      setOperationBusy(false)
      closeOperation()
      await refresh()
    }
  }

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
      },
      newFolder: startNewFolder,
      rename: startRename,
      deleteSelection: startDelete,
      toggleTerminal,
      newTerminal: openTerminal,
      splitTerminal,
      search: startSearch,
      zoomIn: () => adjustZoom(1),
      zoomOut: () => adjustZoom(-1),
      resetZoom
    }),
    [
      refresh,
      goBack,
      goUp,
      listing,
      selectedEntries,
      selectAll,
      startNewFolder,
      startRename,
      startDelete,
      toggleTerminal,
      openTerminal,
      splitTerminal,
      startSearch,
      adjustZoom,
      resetZoom
    ]
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

  /**
   * Right-click: a row that isn't already selected becomes the selection, and
   * the menu acts on the selection; on the empty part of the list, on the folder.
   */
  async function showContextMenu(entry: FileEntry | null): Promise<void> {
    if (listing === null) return
    let targets: FileEntry[] = []
    if (entry !== null) {
      targets = selectedPaths.has(entry.path) ? selectedEntries : [entry]
      if (!selectedPaths.has(entry.path)) select(entry.path)
    }
    const action = await appService.showContextMenu(
      fileContextMenu({
        side,
        entries: targets,
        canTransfer: onTransfer !== undefined && canTransfer,
        canModify: operations !== undefined,
        trash: operations?.trash ?? false
      })
    )
    const first = targets[0]
    switch (action) {
      case 'open':
        if (first !== undefined) openEntry(first)
        return
      case 'upload':
      case 'download':
        onTransfer?.(targets)
        return
      case 'new-folder':
        startNewFolder()
        return
      case 'rename':
        if (operations === undefined || first === undefined) return
        setNameError(null)
        setOperation({ kind: 'rename', entry: first })
        return
      case 'move-to-trash':
      case 'delete':
        if (operations !== undefined && targets.length > 0) setOperation({ kind: 'delete', entries: targets })
        return
      case 'refresh':
        void refresh()
        return
      case null:
        return
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // Zoom first, because it applies to whatever the pane is showing — a shell
    // included. The menu owns the plain "=", "-" and "0"; these are the shifted
    // and keypad forms of the same keys, which a menu item can't also carry.
    if (event.metaKey || event.ctrlKey) {
      const direction = ZOOM_KEYS[event.key]
      if (direction !== undefined) {
        event.preventDefault()
        if (direction === 0) resetZoom()
        else adjustZoom(direction)
        return
      }
    }

    // Keys typed in the terminal belong to the shell, including Tab and Backspace.
    if (tab === 'terminal') return

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

    if (operations !== undefined) {
      if (event.key === 'F2') {
        event.preventDefault()
        startRename()
        return
      }
      if (event.key === 'Delete' || (isMac && event.key === 'Backspace' && event.metaKey)) {
        event.preventDefault()
        startDelete()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startNewFolder()
        return
      }
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


  const place = operations?.platform === 'win32' ? 'Recycle Bin' : 'Trash'
  const deleteTitle = (items: FileEntry[]): string => {
    const what = items.length === 1 ? `"${items[0]?.name ?? ''}"` : `${items.length} items`
    return operations?.trash ? `Move ${what} to the ${place}?` : `Permanently delete ${what}?`
  }

  return (
    <>
      <section
        ref={paneRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={onActivate}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label={`${title} files`}
        data-active={active}
        data-drop-active={dropDestination !== null || undefined}
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-[#11141b] outline-none transition-colors ${
          dropDestination !== null ? 'border-sky-400 ring-2 ring-sky-400/40' : active ? 'border-sky-500/35' : 'border-white/[0.07]'
        }`}
      >
        {terminal !== undefined && (
          <PaneTabs
            active={tab}
            paneActive={active}
            terminals={terminals}
            activeTerminal={activeTerminal}
            onShowFiles={showFiles}
            onShowTerminal={showTerminal}
            onNewTerminal={openTerminal}
            onCloseTerminal={closeTerminal}
            canAdd={canAddTerminal(terminals, side)}
            cap={maxTerminalsFor(side)}
          />
        )}

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
          onNewFolder={operations === undefined ? undefined : startNewFolder}
          onSearch={startSearch}
          searching={searching}
        />

        {searching && tab === 'files' && (
          <PaneSearch
            label={title}
            value={search}
            matches={entries.length}
            onChange={setSearch}
            onCommit={() => {
              // Done typing: the list takes the keyboard, starting at the first match.
              const first = entries[0]
              if (first !== undefined) select(first.path)
              paneRef.current?.focus()
            }}
            onClose={endSearch}
          />
        )}

        {operationMessage !== null && (
          <div
            role="alert"
            data-testid="operation-message"
            className="flex shrink-0 items-start justify-between gap-3 border-b border-red-500/15 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300"
          >
            <span className="select-text">{operationMessage}</span>
            <button type="button" onClick={() => setOperationMessage(null)} className="shrink-0 text-[11px] text-red-300/70 hover:text-red-200">
              Dismiss
            </button>
          </div>
        )}

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

        <div
          ref={scrollRef}
          data-testid="file-list"
          hidden={tab === 'terminal'}
          style={{ zoom }}
          className="min-h-0 flex-1 overflow-y-auto"
          onContextMenu={(event) => {
            // A row's own menu has already been handled.
            if (event.defaultPrevented) return
            event.preventDefault()
            void showContextMenu(null)
          }}
        >
          {listing !== null && (
            <FileTable
              entries={entries}
              selectedPaths={selectedPaths}
              cursorPath={selectedPath}
              loadingPath={loadingPath}
              active={active}
              onSelect={select}
              onOpen={openEntry}
              onDragStart={startDrag}
              onContextMenu={(entry) => void showContextMenu(entry)}
              dropTargetPath={dropDestination !== null && dropDestination !== listing.path ? dropDestination : null}
            />
          )}
          {listing !== null && entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-zinc-600">This folder is empty.</p>
          )}
        </div>

        {terminal !== undefined &&
          terminals.map((item) => {
            const showing = tab === 'terminal' && item.key === activeTerminal
            return (
              // Every terminal stays mounted: unmounting one would end its
              // session, so only the one on show is visible.
              <div
                key={item.key}
                hidden={!showing}
                data-terminal={item.key}
                data-showing={showing || undefined}
                data-panes={paneCount(item.layout)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TerminalPanes
                  node={item.layout}
                  side={terminal.side}
                  {...(terminal.connectionId === undefined ? {} : { connectionId: terminal.connectionId })}
                  visible={showing}
                  fontSize={terminalFontSize(zoom)}
                  focusedPane={focusedPane}
                  onFocusPane={setFocusedPane}
                  onClosePane={closePane}
                  onSplitPane={splitPaneFrom}
                  onNewTerminal={openTerminal}
                  canSplit={canAddTerminal(terminals, side)}
                  onResize={resizePane}
                />
              </div>
            )
          })}

        {dropDestination !== null && (
          <div
            data-testid="drop-label"
            className="pointer-events-none absolute inset-x-3 bottom-8 truncate rounded-md bg-sky-600 px-3 py-1.5 text-center text-[12px] font-medium text-white shadow-lg"
          >
            {dropMoves ? 'Move' : side === 'remote' ? 'Upload' : 'Download'} to {dropDestination}
          </div>
        )}

        <PaneFooter
          count={listing === null ? null : entries.length}
          total={totalCount}
          selected={selectedEntries}
          zoom={zoom}
          onResetZoom={resetZoom}
        />
      </section>

      {/* Outside the section, so keys typed in a dialog never reach the list's shortcuts. */}
      {operations !== undefined && operation !== null && operation.kind !== 'delete' && (
        <NameDialog
          title={operation.kind === 'new-folder' ? 'New folder' : `Rename "${operation.entry.name}"`}
          confirmLabel={operation.kind === 'new-folder' ? 'Create' : 'Rename'}
          initial={operation.kind === 'new-folder' ? 'untitled folder' : operation.entry.name}
          isFolder={operation.kind === 'new-folder' || operation.entry.kind === 'directory'}
          platform={operations.platform}
          busy={operationBusy}
          error={nameError}
          onSubmit={(name) => void submitName(name)}
          onCancel={closeOperation}
        />
      )}
      {operations !== undefined && operation?.kind === 'delete' && (
        <ConfirmDialog
          title={deleteTitle(operation.entries)}
          message={
            operations.trash
              ? `${listNames(operation.entries.map((entry) => entry.name))} will be moved to the ${place}, where you can restore ${operation.entries.length === 1 ? 'it' : 'them'}.`
              : `${listNames(operation.entries.map((entry) => entry.name))} will be deleted from the server. Folders are deleted with everything inside them. This can't be undone.`
          }
          confirmLabel={operationBusy ? 'Deleting…' : operations.trash ? `Move to ${place}` : 'Delete'}
          onConfirm={() => void confirmDelete(operation.entries)}
          onCancel={closeOperation}
        />
      )}
    </>
  )
}
