import { useCallback, useEffect, useState } from 'react'
import type { ConnectionSummary } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'
import { connectionsService } from '@renderer/services/connections.service'

export interface ConnectionProfilesState {
  profiles: ConnectionSummary[]
  loading: boolean
  error: AppErrorPayload | null
  reload: () => Promise<void>
}

/** The saved connections list. Holds summaries only; secrets stay in the main process. */
export function useConnectionProfiles(): ConnectionProfilesState {
  const [profiles, setProfiles] = useState<ConnectionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AppErrorPayload | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setProfiles(await connectionsService.list())
      setError(null)
    } catch (cause) {
      setError(cause as AppErrorPayload)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { profiles, loading, error, reload }
}
