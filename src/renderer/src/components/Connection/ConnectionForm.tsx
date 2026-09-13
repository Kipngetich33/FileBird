import { useEffect, useState, type FormEvent, type JSX } from 'react'
import type { ConnectionInput, KeyInfo } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'
import { connectionsService } from '@renderer/services/connections.service'
import { APP_NAME } from '@shared/constants/app'

interface ConnectionFormProps {
  mode: 'new' | 'edit'
  initial: ConnectionInput | null
  busy: boolean
  error: AppErrorPayload | null
  onCancel: () => void
  onSave: (input: ConnectionInput) => void
  onSaveAndConnect: (input: ConnectionInput) => void
  /** Only offered for new connections. */
  onConnectUnsaved: (input: ConnectionInput) => void
  onDismissError: () => void
}

const INPUT =
  'w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-100 outline-none select-text placeholder:text-zinc-600 focus:border-sky-500/60 disabled:opacity-50'
const LABEL = 'text-[11px] text-zinc-400'
const SECONDARY =
  'rounded-md border border-white/10 px-3 py-1.5 text-[12px] text-zinc-300 transition hover:border-white/20 hover:text-zinc-100 disabled:opacity-40'

type Inspection = { state: 'idle' } | { state: 'ok'; info: KeyInfo } | { state: 'error'; message: string }

/** An absolute path on macOS, Linux or Windows; anything else isn't worth asking main about. */
const looksAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

function describeKey(info: KeyInfo): string {
  const parts = [info.algorithm === null ? 'Private key' : `${info.algorithm} key`]
  if (info.encrypted) parts.push('passphrase-protected')
  if (info.fingerprint !== null) parts.push(info.fingerprint)
  return parts.join(' · ')
}

/**
 * New or edited connection. No password or passphrase field: those are asked
 * for when connecting, and saved only after the server accepts them.
 */
export function ConnectionForm(props: ConnectionFormProps): JSX.Element {
  const { mode, initial, busy, error } = props
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<'password' | 'privateKey'>(initial?.auth.type ?? 'privateKey')
  const [keyPath, setKeyPath] = useState(initial?.auth.type === 'privateKey' ? initial.auth.privateKeyPath : '')
  const [inspection, setInspection] = useState<Inspection>({ state: 'idle' })

  useEffect(() => {
    if (authType !== 'privateKey' || !looksAbsolute(keyPath.trim())) {
      setInspection({ state: 'idle' })
      return
    }
    let current = true
    const timer = setTimeout(() => {
      connectionsService
        .inspectKey(keyPath.trim())
        .then((info) => current && setInspection({ state: 'ok', info }))
        .catch((cause: AppErrorPayload) => current && setInspection({ state: 'error', message: cause.message }))
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [authType, keyPath])

  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const keyValid = authType === 'password' || looksAbsolute(keyPath.trim())
  const canConnect = !busy && host.trim() !== '' && username.trim() !== '' && portValid && keyValid
  const canSave = canConnect && name.trim() !== ''

  const input = (): ConnectionInput => ({
    name: name.trim(),
    host: host.trim(),
    port: portNumber,
    username: username.trim(),
    auth: authType === 'password' ? { type: 'password' } : { type: 'privateKey', privateKeyPath: keyPath.trim() }
  })

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (canSave) props.onSaveAndConnect(input())
  }

  async function browse(): Promise<void> {
    try {
      const picked = await connectionsService.pickKey()
      if (picked !== null) setKeyPath(picked)
    } catch (cause) {
      setInspection({ state: 'error', message: (cause as AppErrorPayload).message })
    }
  }

  return (
    <form onSubmit={submit} aria-label={mode === 'new' ? 'New connection' : 'Edit connection'} className="mx-auto w-full max-w-md space-y-3">
      <h2 className="text-[14px] font-semibold text-zinc-100">{mode === 'new' ? 'New connection' : 'Edit connection'}</h2>

      {error !== null && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300">
          <span className="select-text">{error.message}</span>
          <button type="button" onClick={props.onDismissError} className="shrink-0 text-[11px] text-red-300/70 hover:text-red-200">
            Dismiss
          </button>
        </div>
      )}

      <label className="block space-y-1">
        <span className={LABEL}>Name</span>
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production server" autoComplete="off" disabled={busy} className={INPUT} />
      </label>

      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <label className="space-y-1">
          <span className={LABEL}>Host</span>
          <input name="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" autoComplete="off" spellCheck={false} disabled={busy} className={INPUT} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Port</span>
          <input name="port" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" aria-invalid={!portValid} disabled={busy} className={INPUT} />
        </label>
      </div>

      <label className="block space-y-1">
        <span className={LABEL}>Username</span>
        <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} className={INPUT} />
      </label>

      <fieldset className="space-y-2">
        <legend className={LABEL}>Authentication</legend>
        <div className="flex gap-4 text-[12px] text-zinc-300">
          {(['privateKey', 'password'] as const).map((type) => (
            <label key={type} className="flex items-center gap-1.5">
              <input type="radio" name="auth" value={type} checked={authType === type} onChange={() => setAuthType(type)} disabled={busy} />
              {type === 'privateKey' ? 'Private key' : 'Password'}
            </label>
          ))}
        </div>

        {authType === 'privateKey' ? (
          <div className="space-y-1">
            <div className="flex gap-2">
              <input
                name="privateKeyPath"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="/Users/you/.ssh/id_ed25519"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                className={`${INPUT} font-mono`}
              />
              <button type="button" onClick={() => void browse()} disabled={busy} className={`${SECONDARY} shrink-0`}>
                Browse…
              </button>
            </div>
            {inspection.state === 'ok' && (
              <p data-testid="key-info" className="text-[11px] break-all text-zinc-400">
                {describeKey(inspection.info)}
                {inspection.info.permissionsTooOpen && (
                  <span className="block text-amber-300/90">Other users can read this file; OpenSSH itself would refuse it (chmod 600).</span>
                )}
              </p>
            )}
            {inspection.state === 'error' && (
              <p data-testid="key-error" className="text-[11px] break-all text-red-300">
                {inspection.message}
              </p>
            )}
            <p className="text-[11px] text-zinc-600">{APP_NAME} reads the key file only when connecting. If it has a passphrase, you'll be asked for it.</p>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-600">You'll be asked for the password when connecting.</p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button type="button" onClick={props.onCancel} disabled={busy} className={SECONDARY}>
          Cancel
        </button>
        {mode === 'new' && (
          <button type="button" onClick={() => props.onConnectUnsaved(input())} disabled={!canConnect} className={SECONDARY}>
            Connect without saving
          </button>
        )}
        <button type="button" onClick={() => props.onSave(input())} disabled={!canSave} className={SECONDARY}>
          Save
        </button>
        <button type="submit" disabled={!canSave} className="rounded-md bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? 'Connecting…' : 'Save & connect'}
        </button>
      </div>
    </form>
  )
}
