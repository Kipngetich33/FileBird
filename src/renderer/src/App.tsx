import type { JSX } from 'react'
import { TitleBar } from '@renderer/components/Layout/TitleBar'
import { StatusBar } from '@renderer/components/Layout/StatusBar'
import { MainPage } from '@renderer/pages/MainPage'
import { useSystemInfo } from '@renderer/hooks/useSystemInfo'

export default function App(): JSX.Element {
  const { versions } = useSystemInfo()
  const isMac = versions === null ? true : versions.platform === 'darwin'

  return (
    <div className="flex h-full flex-col">
      <TitleBar isMac={isMac} status={versions === null ? 'Starting…' : 'Not connected'} />
      <MainPage />
      <StatusBar
        left={versions === null ? 'Initialising' : 'Foundation ready'}
        right={versions === null ? '—' : `Electron ${versions.electron} · Node ${versions.node}`}
      />
    </div>
  )
}
