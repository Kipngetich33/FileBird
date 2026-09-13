import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectOutcome, ConnectionInfo } from '@shared/types/connection'
import type { ConnectionInput, ConnectionSummary, SecretEntry } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'
import { connectionsService } from '@renderer/services/connections.service'
import { sftpService } from '@renderer/services/sftp.service'

export type HostKeyPrompt = Extract<ConnectOutcome, { status: 'host-key-unknown' }>
export type HostKeyChange = Extract<ConnectOutcome, { status: 'host-key-changed' }>

/** What is being connected: a saved profile, or form input that isn't saved. */
export type ConnectTarget = { kind: 'saved'; profile: ConnectionSummary } | { kind: 'unsaved'; input: ConnectionInput }

export interface SecretRequest {
  target: ConnectTarget
  kind: 'password' | 'passphrase'
  reason: 'not-saved' | 'rejected'
}

type Phase =
  | { name: 'idle' }
  | { name: 'connecting' }
  | { name: 'secret-required'; request: SecretRequest }
  | { name: 'confirm-host-key'; prompt: HostKeyPrompt }
  | { name: 'host-key-changed'; change: HostKeyChange }
  | { name: 'connected'; connection: ConnectionInfo }

export interface RemoteConnectionState {
  phase: Phase['name']
  connection: ConnectionInfo | null
  secretRequest: SecretRequest | null
  hostKeyPrompt: HostKeyPrompt | null
  hostKeyChange: HostKeyChange | null
  error: AppErrorPayload | null
  notice: string | null
  lastTarget: ConnectTarget | null
  connectSaved: (profile: ConnectionSummary) => Promise<void>
  connectUnsaved: (input: ConnectionInput) => Promise<void>
  submitSecret: (secret: SecretEntry) => Promise<void>
  cancelSecret: () => void
  trustHostKey: () => Promise<void>
  cancelHostKey: () => void
  forgetChangedHostKey: () => Promise<void>
  dismissHostKeyChange: () => void
  disconnect: () => Promise<void>
  dismissError: () => void
  dismissNotice: () => void
}

const authTypeOf = (target: ConnectTarget | null): string | undefined =>
  target === null ? undefined : target.kind === 'saved' ? target.profile.auth.type : target.input.auth.type

/**
 * The remote side's connection state, driven by the main process, which owns
 * the connection and every secret (spec section 16). The renderer holds a
 * connection id; a typed password or passphrase passes through once.
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

  const settle = useCallback(async (attempt: () => Promise<ConnectOutcome>, target: ConnectTarget | null) => {
    setError(null)
    setNotice(null)
    setPhase({ name: 'connecting' })
    try {
      const outcome = await attempt()
      switch (outcome.status) {
        case 'connected':
          setPhase({ name: 'connected', connection: outcome.connection })
          if (outcome.notice !== undefined) setNotice(outcome.notice)
          break
        case 'host-key-unknown':
          setPhase({ name: 'confirm-host-key', prompt: outcome })
          break
        case 'host-key-changed':
          setPhase({ name: 'host-key-changed', change: outcome })
          break
        case 'secret-required':
          if (target === null) {
            setPhase({ name: 'idle' })
            break
          }
          setPhase({ name: 'secret-required', request: { target, kind: outcome.kind, reason: outcome.reason } })
          break
      }
    } catch (cause) {
      const failure = cause as AppErrorPayload
      // A password rejected after the host key was trusted: ask again rather than dead-end.
      if (failure.code === 'AUTH_FAILED' && target !== null && authTypeOf(target) === 'password') {
        setPhase({ name: 'secret-required', request: { target, kind: 'password', reason: 'rejected' } })
        return
      }
      setError(failure)
      setPhase({ name: 'idle' })
    }
  }, [])

  const attempt = useCallback(
    (target: ConnectTarget, secret?: SecretEntry) => {
      setLastTarget(target)
      return settle(
        () =>
          target.kind === 'saved'
            ? connectionsService.connect(target.profile.id, secret)
            : connectionsService.connectUnsaved(target.input, secret),
        target
      )
    },
    [settle]
  )

  const connectSaved = useCallback((profile: ConnectionSummary) => attempt({ kind: 'saved', profile }), [attempt])
  const connectUnsaved = useCallback((input: ConnectionInput) => attempt({ kind: 'unsaved', input }), [attempt])

  const submitSecret = useCallback(
    async (secret: SecretEntry) => {
      if (phase.name !== 'secret-required') return
      await attempt(phase.request.target, secret)
    },
    [phase, attempt]
  )

  const trustHostKey = useCallback(async () => {
    if (phase.name !== 'confirm-host-key') return
    const { token } = phase.prompt
    await settle(() => sftpService.trustHostKeyAndConnect(token), lastTarget)
  }, [phase, settle, lastTarget])

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
    setNotice(null)
    try {
      await sftpService.disconnect(id)
    } catch (cause) {
      setError(cause as AppErrorPayload)
    }
  }, [phase])

  const backToIdle = useCallback(() => setPhase({ name: 'idle' }), [])

  return {
    phase: phase.name,
    connection: phase.name === 'connected' ? phase.connection : null,
    secretRequest: phase.name === 'secret-required' ? phase.request : null,
    hostKeyPrompt: phase.name === 'confirm-host-key' ? phase.prompt : null,
    hostKeyChange: phase.name === 'host-key-changed' ? phase.change : null,
    error,
    notice,
    lastTarget,
    connectSaved,
    connectUnsaved,
    submitSecret,
    cancelSecret: backToIdle,
    trustHostKey,
    cancelHostKey: backToIdle,
    forgetChangedHostKey,
    dismissHostKeyChange: backToIdle,
    disconnect,
    dismissError: useCallback(() => setError(null), []),
    dismissNotice: useCallback(() => setNotice(null), [])
  }
}
