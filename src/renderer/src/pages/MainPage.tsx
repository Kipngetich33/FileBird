import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { FileEntry } from '@shared/types/files'
import type { TransferJob } from '@shared/types/transfers'
import { FilePane } from '@renderer/components/FileManager/FilePane'
import { RemotePane } from '@renderer/components/FileManager/RemotePane'
import { TransferButton } from '@renderer/components/FileManager/TransferButton'
import type { PaneHandle, PaneId, PaneOperations } from '@renderer/components/FileManager/pane'
import { SplitLayout } from '@renderer/components/Layout/SplitLayout'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { ConflictDialog } from '@renderer/components/Transfers/ConflictDialog'
import { TransferPanel } from '@renderer/components/Transfers/TransferPanel'
import { useDirectory } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
import { useTransferQueue } from '@renderer/hooks/useTransferQueue'
import type { DraggedEntry } from '@renderer/utils/drag'
import { appService } from '@renderer/services/app.service'
import { filesService } from '@renderer/services/files.service'
import { localFilesService } from '@renderer/services/local-files.service'
import { systemService } from '@renderer/services/system.service'

interface MainPageProps {
  runtimeLabel: string
  remote: RemoteConnectionState
  /** This computer's platform, for local naming rules and the Trash's name. */
  platform: string
}

/** Completed jobs arrive in bursts; the destination pane refreshes once they settle. */
const REFRESH_DEBOUNCE_MS = 400

/**
 * Local | Remote, side by side and independent (spec Milestone 5). Exactly one
 * pane is active, the one focus last entered, and menu commands act on it.
 * The transfer queue (Milestone 7) spans both panes, so it lives here too.
 */
export function MainPage({ runtimeLabel, remote, platform }: MainPageProps): JSX.Element {
  const local = useDirectory(localFilesService)
  const localOperations = useMemo<PaneOperations>(() => {
    const target = { side: 'local' } as const
    return {
      platform,
      trash: true,
      createFolder: (parent, name) => filesService.createFolder(target, parent, name),
      rename: (path, newName) => filesService.rename(target, path, newName),
      remove: (paths) => filesService.remove(target, paths),
      move: (paths, destination) => filesService.move(target, paths, destination)
    }
  }, [platform])
  const [active, setActive] = useState<PaneId>('local')
  const localRef = useRef<PaneHandle>(null)
  const remoteRef = useRef<PaneHandle>(null)
  const [panelExpanded, setPanelExpanded] = useState(false)
  // Once the user hides the panel, new requests don't reopen it until the queue is idle again.
  const hiddenWhileBusy = useRef(false)

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRefresh = useRef({ local: new Set<string>(), remote: new Set<string>() })
  const refreshSoon = (side: PaneId, directory: string): void => {
    pendingRefresh.current[side].add(directory)
    if (refreshTimer.current !== null) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      for (const side of ['local', 'remote'] as const) {
        for (const directory of pendingRefresh.current[side]) (side === 'local' ? localRef : remoteRef).current?.refreshIfShowing(directory)
        pendingRefresh.current[side].clear()
      }
    }, REFRESH_DEBOUNCE_MS)
  }
  useEffect(() => () => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
  }, [])

  const destinationSide = (direction: TransferJob['direction']): PaneId => (direction === 'upload' ? 'remote' : 'local')

  const transfers = useTransferQueue({
    onQueued: (request) => {
      // New folders exist at the destination as soon as a request is queued.
      refreshSoon(destinationSide(request.direction), request.destinationDirectory)
      if (!hiddenWhileBusy.current) setPanelExpanded(true)
    },
    onCompleted: (jobs) => {
      for (const job of jobs) refreshSoon(destinationSide(job.direction), job.destinationDirectory)
    }
  })

  const queueBusy = transfers.summary.active > 0
  useEffect(() => {
    if (!queueBusy) hiddenWhileBusy.current = false
  }, [queueBusy])

  // The subscription is made once, so it reads the active pane through a ref.
  const activeRef = useRef<PaneId>(active)
  activeRef.current = active

  // Asked for once: where a download goes when it wasn't dragged to a folder.
  const [downloadFolder, setDownloadFolder] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void localFilesService
      .getDownloadFolder()
      .then((folder) => {
        if (current) setDownloadFolder(folder)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [])

  /**
   * Sends the entries to `into` (a drop on a folder), else to where that kind of
   * transfer belongs: an upload to the folder the remote pane is showing, and a
   * download to the Downloads folder, the way a browser would. Dragging is how
   * you send a download somewhere else.
   */
  function transferEntries(from: PaneId, entries: Array<FileEntry | DraggedEntry>, into?: string): void {
    const connection = remote.connection
    const direction = from === 'local' ? 'upload' : 'download'
    const destination =
      into ?? (from === 'local' ? (remoteRef.current?.currentPath() ?? null) : (downloadFolder ?? localRef.current?.currentPath() ?? null))
    const transferable = entries.filter((entry) => entry.kind !== 'other')
    if (connection === null) return transfers.refuse('Connect to a server first.')
    if (entries.length === 0) return transfers.refuse(`Select files or folders to ${direction}.`)
    if (transferable.length === 0) return transfers.refuse("Broken links and special files can't be transferred.")
    if (destination === null) return transfers.refuse('Wait for the other pane to finish loading.')
    void transfers.start({
      connectionId: connection.id,
      direction,
      sourcePaths: transferable.map((entry) => entry.path),
      destinationDirectory: destination
    })
  }
  const transferRef = useRef(transferEntries)
  transferRef.current = transferEntries

  useEffect(
    () =>
      appService.onMenuCommand((command) => {
        const pane = (id: PaneId): PaneHandle | null => (id === 'local' ? localRef : remoteRef).current
        switch (command) {
          case 'focus-local':
            pane('local')?.focus()
            break
          case 'focus-remote':
            pane('remote')?.focus()
            break
          case 'refresh':
            pane(activeRef.current)?.refresh()
            break
          case 'go-back':
            pane(activeRef.current)?.goBack()
            break
          case 'go-up':
            pane(activeRef.current)?.goUp()
            break
          case 'transfer':
            transferRef.current(activeRef.current, pane(activeRef.current)?.selectedEntries() ?? [])
            break
          case 'toggle-terminal':
            pane(activeRef.current)?.toggleTerminal()
            break
          case 'find':
            pane(activeRef.current)?.search()
            break
          case 'new-folder':
          case 'rename':
          case 'delete': {
            // One dialog at a time: a shortcut pressed while one is open does nothing.
            if (document.querySelector('[role="dialog"]') !== null) break
            const target = pane(activeRef.current)
            if (command === 'new-folder') target?.newFolder()
            else if (command === 'rename') target?.rename()
            else target?.deleteSelection()
            break
          }
          case 'select-all': {
            // The menu owns Cmd+A, so text fields get their usual behaviour from here.
            const focused = document.activeElement
            if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.select()
            else pane(activeRef.current)?.selectAll()
            break
          }
        }
      }),
    []
  )

  const activeLabel =
    active === 'local'
      ? 'Local'
      : remote.connection !== null
        ? `Remote · ${remote.connection.username}@${remote.connection.host}`
        : 'Remote'

  return (
    <>
      <main className="flex min-h-0 flex-1 p-3">
        <SplitLayout
          left={
            <FilePane
              ref={localRef}
              title="Local"
              directory={local}
              active={active === 'local'}
              onActivate={() => setActive('local')}
              onSwitchPane={() => remoteRef.current?.focus()}
              operations={localOperations}
              side="local"
              onDropEntries={(source, entries, destination) => transferEntries(source, entries, destination)}
              onTransfer={(entries) => transferEntries('local', entries)}
              canTransfer={remote.connection !== null}
              terminal={{ side: 'local' }}
              actions={
                <TransferButton
                  direction="upload"
                  entries={local.selectedEntries}
                  unavailableReason={remote.connection === null ? 'Connect to a server to upload' : undefined}
                  onClick={() => transferEntries('local', local.selectedEntries)}
                />
              }
            />
          }
          right={
            <RemotePane
              ref={remoteRef}
              remote={remote}
              active={active === 'remote'}
              onActivate={() => setActive('remote')}
              onSwitchPane={() => localRef.current?.focus()}
              onDownload={(entries) => transferEntries('remote', entries)}
              downloadFolder={downloadFolder}
              activeTransfers={remote.connection === null ? 0 : transfers.activeCountFor(remote.connection.id)}
              onDropEntries={(source, entries, destination) => transferEntries(source, entries, destination)}
            />
          }
        />
      </main>
      <TransferPanel
        jobs={transfers.jobs}
        summary={transfers.summary}
        expanded={panelExpanded}
        onToggle={() => {
          if (panelExpanded && queueBusy) hiddenWhileBusy.current = true
          setPanelExpanded(!panelExpanded)
        }}
        preparing={transfers.preparing}
        notice={transfers.notice}
        refusal={transfers.refusal}
        onCancel={transfers.cancel}
        onRetry={transfers.retry}
        onCancelAll={transfers.cancelAll}
        onRetryFailed={transfers.retryFailed}
        onClearFinished={transfers.clearFinished}
        onDismissNotice={transfers.dismissNotice}
        platform={platform}
        onReveal={(path) => void systemService.revealInFolder(path).catch((error: AppErrorPayload) => transfers.refuse(error.message))}
        onDismissRefusal={transfers.dismissRefusal}
      />
      <StatusBar left={activeLabel} right={runtimeLabel} />
      {transfers.conflict !== null && (
        <ConflictDialog
          conflict={transfers.conflict}
          onReplace={() => void transfers.resolveConflict('replace')}
          onKeepBoth={() => void transfers.resolveConflict('keep-both')}
          onSkip={() => void transfers.resolveConflict('skip')}
          onCancel={transfers.cancelConflict}
        />
      )}
    </>
  )
}
