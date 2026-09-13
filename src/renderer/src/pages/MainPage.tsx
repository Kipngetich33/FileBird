import { useEffect, useRef, useState, type JSX } from 'react'
import { FilePane } from '@renderer/components/FileManager/FilePane'
import { RemotePane } from '@renderer/components/FileManager/RemotePane'
import type { PaneHandle, PaneId } from '@renderer/components/FileManager/pane'
import { SplitLayout } from '@renderer/components/Layout/SplitLayout'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { useDirectory } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
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

  // The subscription is made once, so it reads the active pane through a ref.
  const activeRef = useRef<PaneId>(active)
  activeRef.current = active

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
            />
          }
          right={
            <RemotePane
              ref={remoteRef}
              remote={remote}
              active={active === 'remote'}
              onActivate={() => setActive('remote')}
              onSwitchPane={() => localRef.current?.focus()}
            />
          }
        />
      </main>
      <StatusBar left={activeLabel} right={runtimeLabel} />
    </>
  )
}
