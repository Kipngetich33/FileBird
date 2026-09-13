import type { JSX } from 'react'
import { TitleBar } from '@renderer/components/Layout/TitleBar'
import { MainPage } from '@renderer/pages/MainPage'
import { useRemoteConnection } from '@renderer/hooks/useRemoteConnection'
import { useSystemInfo } from '@renderer/hooks/useSystemInfo'

export default function App(): JSX.Element {
  const { versions } = useSystemInfo()
  const remote = useRemoteConnection()
  const isMac = versions === null ? true : versions.platform === 'darwin'

  const status =
    versions === null
      ? 'Starting…'
      : remote.connection !== null
        ? `Connected to ${remote.connection.username}@${remote.connection.host}`
        : remote.phase === 'connecting'
          ? 'Connecting…'
          : 'Not connected'

  return (
    <div className="flex h-full flex-col">
      <TitleBar isMac={isMac} status={status} />
      <MainPage
        remote={remote}
        platform={versions?.platform ?? (isMac ? 'darwin' : 'linux')}
        runtimeLabel={versions === null ? '—' : `Electron ${versions.electron} · Node ${versions.node}`}
      />
    </div>
  )
}
