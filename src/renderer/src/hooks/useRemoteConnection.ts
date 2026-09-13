import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectOutcome, ConnectRequest, ConnectionInfo } from '@shared/types/connection'
import type { AppErrorPayload } from '@shared/types/errors'
import { sftpService } from '@renderer/services/sftp.service'

export type HostKeyPrompt = Extract<ConnectOutcome, { status: 'host-key-unknown' }>
export type HostKeyChange = Extract<ConnectOutcome, { status: 'host-key-changed' }>

/** What the connect form is pre-filled with. Never includes the password. */
export interface ConnectTarget {
  host: string
  port: number
  username: string
}

type Phase =
  | { name: 'idle' }
  | { name: 'connecting' }
  | { name: 'confirm-host-key'; prompt: HostKeyPrompt }
  | { name: 'host-key-changed'; change: HostKeyChange }
  | { name: 'connected'; connection: ConnectionInfo }

export interface RemoteConnectionState {
  phase: Phase['name']
  connection: ConnectionInfo | null
  hostKeyPrompt: HostKeyPrompt | null
  hostKeyChange: HostKeyChange | null
  error: AppErrorPayload | null
  notice: string | null
  lastTarget: ConnectTarget | null
  connect: (request: ConnectRequest) => Promise<void>
  trustHostKey: () => Promise<void>
  cancelHostKey: () => void
  forgetChangedHostKey: () => Promise<void>
  dismissHostKeyChange: () => void
  disconnect: () => Promise<void>
  dismissError: () => void
}

/**
 * The remote side's connection state, driven by the main process, which owns
 * the actual connection (spec section 16). Holds a connection id, never the
 * password: that goes to the main process once, inside the connect request.
 */
export function useRemoteConnection(): RemoteConnectionState {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<AppErrorPayload | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lastTarget, setLastTarget] = useState<ConnectTarget | null>(null)

  const connectedId = useRef<string | null>(null)
  connectedId.current = phase.name === 'connected' ? phase.connection.id : null

  useEffect(
    () =>
      sftpService.onConnectionClosed((event) => {
        if (event.connectionId !== connectedId.current) return
        setPhase({ name: 'idle' })
        setError({ code: event.code, message: event.message })
      }),
    []
  )

  const settle = useCallback(async (attempt: () => Promise<ConnectOutcome>) => {
    setError(null)
    setNotice(null)
    setPhase({ name: 'connecting' })
    try {
      const outcome = await attempt()
      switch (outcome.status) {
        case 'connected':
          setPhase({ name: 'connected', connection: outcome.connection })
          break
        case 'host-key-unknown':
          setPhase({ name: 'confirm-host-key', prompt: outcome })
          break
        case 'host-key-changed':
          setPhase({ name: 'host-key-changed', change: outcome })
          break
      }
    } catch (cause) {
      setError(cause as AppErrorPayload)
      setPhase({ name: 'idle' })
    }
  }, [])

  const connect = useCallback(
    (request: ConnectRequest) => {
      setLastTarget({ host: request.host, port: request.port, username: request.username })
      return settle(() => sftpService.connect(request))
    },
    [settle]
  )

  const trustHostKey = useCallback(async () => {
    if (phase.name !== 'confirm-host-key') return
    const { token } = phase.prompt
    await settle(() => sftpService.trustHostKeyAndConnect(token))
  }, [phase, settle])

  const forgetChangedHostKey = useCallback(async () => {
    if (phase.name !== 'host-key-changed') return
    const { host, port } = phase.change
    setPhase({ name: 'idle' })
    try {
      await sftpService.forgetHostKey(host, port)
      setNotice('The saved key was removed. Connect again to review the new key before trusting it.')
    } catch (cause) {
      setError(cause as AppErrorPayload)
    }
  }, [phase])

  const disconnect = useCallback(async () => {
    if (phase.name !== 'connected') return
    const { id } = phase.connection
    setPhase({ name: 'idle' })
    try {
      await sftpService.disconnect(id)
    } catch (cause) {
      setError(cause as AppErrorPayload)
    }
  }, [phase])

  const backToForm = useCallback(() => setPhase({ name: 'idle' }), [])

  return {
    phase: phase.name,
    connection: phase.name === 'connected' ? phase.connection : null,
    hostKeyPrompt: phase.name === 'confirm-host-key' ? phase.prompt : null,
    hostKeyChange: phase.name === 'host-key-changed' ? phase.change : null,
    error,
    notice,
    lastTarget,
    connect,
    trustHostKey,
    cancelHostKey: backToForm,
    forgetChangedHostKey,
    dismissHostKeyChange: backToForm,
    disconnect,
    dismissError: useCallback(() => setError(null), [])
  }
}
