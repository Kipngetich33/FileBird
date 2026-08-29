import { useCallback, useEffect, useState } from 'react'
import type { SystemVersions } from '@shared/types/system'
import type { AppErrorPayload } from '@shared/types/errors'
import { systemService } from '@renderer/services/system.service'

interface SystemInfoState {
  versions: SystemVersions | null
  error: AppErrorPayload | null
  loading: boolean
  reload: () => void
}

/** Loads runtime versions over IPC — the Milestone 1 proof of life. */
export function useSystemInfo(): SystemInfoState {
  const [versions, setVersions] = useState<SystemVersions | null>(null)
  const [error, setError] = useState<AppErrorPayload | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    systemService
      .getVersions()
      .then((result) => {
        setVersions(result)
        setError(null)
      })
      .catch((cause: AppErrorPayload) => setError(cause))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  return { versions, error, loading, reload: load }
}
