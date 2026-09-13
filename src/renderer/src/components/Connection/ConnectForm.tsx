import { useState, type FormEvent, type JSX } from 'react'
import type { ConnectRequest } from '@shared/types/connection'
import type { AppErrorPayload } from '@shared/types/errors'
import type { ConnectTarget } from '@renderer/hooks/useRemoteConnection'

interface ConnectFormProps {
  initial: ConnectTarget | null
  busy: boolean
  error: AppErrorPayload | null
  notice: string | null
  onSubmit: (request: ConnectRequest) => void
  onDismissError: () => void
}

const INPUT =
  'w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-100 outline-none select-text placeholder:text-zinc-600 focus:border-sky-500/60 disabled:opacity-50'

/**
 * Quick connect (Milestone 3): nothing is saved. The password is cleared from
 * the form as soon as it is sent, so it doesn't linger in renderer state.
 */
export function ConnectForm({ initial, busy, error, notice, onSubmit, onDismissError }: ConnectFormProps): JSX.Element {
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')

  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const canSubmit = !busy && host.trim() !== '' && username.trim() !== '' && portValid

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit({
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      auth: { type: 'password', password }
    })
    setPassword('')
  }

  return (
    <form onSubmit={submit} aria-label="Connect to a server" className="mx-auto w-full max-w-sm space-y-3">
      <div>
        <h2 className="text-[14px] font-semibold text-zinc-100">Connect to a server</h2>
        <p className="mt-0.5 text-[12px] text-zinc-500">SFTP with a password.</p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300"
        >
          <span className="select-text">{error.message}</span>
          <button type="button" onClick={onDismissError} className="shrink-0 text-[11px] text-red-300/70 hover:text-red-200">
            Dismiss
          </button>
        </div>
      )}

      {notice !== null && (
        <p role="status" className="rounded-md border border-sky-500/20 bg-sky-500/[0.07] px-3 py-2 text-[12px] text-sky-200">
          {notice}
        </p>
      )}

      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-zinc-400">Host</span>
          <input
            name="host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className={INPUT}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-zinc-400">Port</span>
          <input
            name="port"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            aria-invalid={!portValid}
            disabled={busy}
            className={INPUT}
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] text-zinc-400">Username</span>
        <input
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={INPUT}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[11px] text-zinc-400">Password</span>
        <input
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
          disabled={busy}
          className={INPUT}
        />
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-md bg-sky-600 px-4 py-2 text-[12px] font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>

      <p className="text-[11px] text-zinc-600">Your password is used for this connection only and is not saved.</p>
    </form>
  )
}
