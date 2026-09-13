import type { JSX } from 'react'
import { FilePane } from '@renderer/components/FileManager/FilePane'
import { RemotePane } from '@renderer/components/FileManager/RemotePane'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { useDirectory } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
import { localFilesService } from '@renderer/services/local-files.service'

interface MainPageProps {
  runtimeLabel: string
  remote: RemoteConnectionState
}

export function MainPage({ runtimeLabel, remote }: MainPageProps): JSX.Element {
  const local = useDirectory(localFilesService)

  const count = local.listing?.entries.length
  const summary =
    count === undefined
      ? local.loading
        ? 'Loading…'
        : '—'
      : `Local: ${count === 1 ? '1 item' : `${count} items`}`

  return (
    <>
      <main className="flex min-h-0 flex-1 gap-3 p-3">
        <FilePane title="Local" directory={local} />
        <RemotePane remote={remote} />
      </main>
      <StatusBar left={summary} right={runtimeLabel} />
    </>
  )
}
