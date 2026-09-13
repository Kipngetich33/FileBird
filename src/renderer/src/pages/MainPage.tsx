import type { JSX } from 'react'
import { FilePane } from '@renderer/components/FileManager/FilePane'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { useDirectory } from '@renderer/hooks/useDirectory'
import { localFilesService } from '@renderer/services/local-files.service'

interface MainPageProps {
  runtimeLabel: string
}

export function MainPage({ runtimeLabel }: MainPageProps): JSX.Element {
  const local = useDirectory(localFilesService)

  const count = local.listing?.entries.length
  const summary =
    count === undefined ? (local.loading ? 'Loading…' : '—') : count === 1 ? '1 item' : `${count} items`

  return (
    <>
      <main className="flex min-h-0 flex-1 p-3">
        <FilePane title="Local" directory={local} />
      </main>
      <StatusBar left={summary} right={runtimeLabel} />
    </>
  )
}
