import { useEffect, useRef, useState, type JSX } from 'react'
import type { FileEntry } from '@shared/types/files'
import { FilePane } from '@renderer/components/FileManager/FilePane'
import { RemotePane } from '@renderer/components/FileManager/RemotePane'
import { TransferButton } from '@renderer/components/FileManager/TransferButton'
import type { PaneHandle, PaneId } from '@renderer/components/FileManager/pane'
import { SplitLayout } from '@renderer/components/Layout/SplitLayout'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { ConflictDialog } from '@renderer/components/Transfers/ConflictDialog'
import { TransferBar } from '@renderer/components/Transfers/TransferBar'
import { useDirectory } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
import { useTransfers } from '@renderer/hooks/useTransfers'
import { appService } from '@renderer/services/app.service'
import { localFilesService } from '@renderer/services/local-files.service'

interface MainPageProps {
  runtimeLabel: string
  remote: RemoteConnectionState
}

/**
 * Local | Remote, side by side and independent (spec Milestone 5). Exactly one
 * pane is active, the one focus last entered, and menu commands act on it.
 */
export function MainPage({ runtimeLabel, remote }: MainPageProps): JSX.Element {
  const local = useDirectory(localFilesService)
  const [active, setActive] = useState<PaneId>('local')
  const localRef = useRef<PaneHandle>(null)
  const remoteRef = useRef<PaneHandle>(null)
  const transfers = useTransfers()

  // The subscription is made once, so it reads the active pane through a ref.
  const activeRef = useRef<PaneId>(active)
  activeRef.current = active

  /** Sends the entry to the folder the other pane is showing. */
  function transferEntry(from: PaneId, entry: FileEntry | null): void {
    const connection = remote.connection
    const direction = from === 'local' ? 'upload' : 'download'
    const destination = (from === 'local' ? remoteRef : localRef).current?.currentPath() ?? null
    if (connection === null) return transfers.refuse('Connect to a server first.')
    if (entry === null) return transfers.refuse(`Select a file to ${direction}.`)
    if (destination === null) return transfers.refuse('Wait for the other pane to finish loading.')
    void transfers.start({ connectionId: connection.id, direction, sourcePath: entry.path, destinationDirectory: destination })
  }
  const transferRef = useRef(transferEntry)
  transferRef.current = transferEntry

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
            transferRef.current(activeRef.current, pane(activeRef.current)?.selectedEntry() ?? null)
            break
        }
      }),
    []
  )

  // Show the new file: refresh the destination pane if it is still on that folder.
  const completed = transfers.transfer?.status === 'completed' ? transfers.transfer : null
  useEffect(() => {
    if (completed === null) return
    const pane = completed.direction === 'upload' ? remoteRef : localRef
    pane.current?.refreshIfShowing(completed.destinationDirectory)
  }, [completed])

  const selectedLocal = local.entries.find((entry) => entry.path === local.selectedPath) ?? null

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
              actions={
                <TransferButton
                  direction="upload"
                  entry={selectedLocal}
                  busy={transfers.running}
                  unavailableReason={remote.connection === null ? 'Connect to a server to upload' : undefined}
                  onClick={() => transferEntry('local', selectedLocal)}
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
              onDownload={(entry) => transferEntry('remote', entry)}
              transferBusy={transfers.running}
            />
          }
        />
      </main>
      <TransferBar
        transfer={transfers.transfer}
        refusal={transfers.refusal}
        onCancel={transfers.cancel}
        onDismiss={transfers.dismiss}
        onDismissRefusal={transfers.dismissRefusal}
      />
      <StatusBar left={activeLabel} right={runtimeLabel} />
      {transfers.conflict !== null && (
        <ConflictDialog
          conflict={transfers.conflict}
          onReplace={() => void transfers.resolveConflict('replace')}
          onKeepBoth={() => void transfers.resolveConflict('keep-both')}
          onCancel={transfers.cancelConflict}
        />
      )}
    </>
  )
}
