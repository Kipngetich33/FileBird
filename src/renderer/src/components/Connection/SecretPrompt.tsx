import { useState, type FormEvent, type JSX } from 'react'
import type { SecretEntry } from '@shared/types/connections'
import type { SecretRequest } from '@renderer/hooks/useRemoteConnection'
import { Dialog, PRIMARY_BUTTON, SECONDARY_BUTTON } from './Dialog'

interface SecretPromptProps {
  request: SecretRequest
  busy: boolean
  onSubmit: (secret: SecretEntry) => void
  onCancel: () => void
}

/** Just the file name, for display. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Asks for a password or key passphrase that isn't saved, or that was just rejected. */
export function SecretPrompt({ request, busy, onSubmit, onCancel }: SecretPromptProps): JSX.Element {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)

  const details = request.target.kind === 'saved' ? request.target.profile : request.target.input
  const canRemember = request.target.kind === 'saved'
  const isPassword = request.kind === 'password'
  const keyName = details.auth.type === 'privateKey' ? fileName(details.auth.privateKeyPath) : ''

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (busy || (isPassword && value === '')) return
    onSubmit({ value, remember: canRemember && remember })
  }

  return (
    <Dialog
      title={isPassword ? `Password for ${details.username}@${details.host}` : `Passphrase for ${keyName}`}
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="submit" form="secret-prompt" disabled={busy} className={PRIMARY_BUTTON}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form id="secret-prompt" onSubmit={submit} className="space-y-3">
        {request.reason === 'rejected' && (
          <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-red-300">
            {isPassword ? 'That password was not accepted.' : 'That passphrase is incorrect for this key.'}
          </p>
        )}
        <input
          name="secret"
          type="password"
          data-autofocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          aria-label={isPassword ? 'Password' : 'Passphrase'}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500/60"
        />
        {canRemember ? (
          <label className="flex items-center gap-2 text-zinc-300">
            <input name="remember" type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember in my keychain
          </label>
        ) : (
          <p className="text-[11px] text-zinc-500">This connection isn't saved, so the {request.kind} won't be remembered.</p>
        )}
        {canRemember && (
          <p className="text-[11px] text-zinc-500">Saved only if the connection succeeds.</p>
        )}
      </form>
    </Dialog>
  )
}
