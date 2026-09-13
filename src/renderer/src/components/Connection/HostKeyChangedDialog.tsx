import { useState, type JSX } from 'react'
import type { HostKeyChange } from '@renderer/hooks/useRemoteConnection'
import { DANGER_BUTTON, Dialog, Fingerprint, SECONDARY_BUTTON } from './Dialog'
import { APP_NAME } from '@shared/constants/app'

interface HostKeyChangedDialogProps {
  change: HostKeyChange
  onForget: () => void
  onClose: () => void
}

/**
 * The server presented a different key from the one trusted before. There is
 * deliberately no "connect anyway": the only way forward is to forget the saved
 * key, confirmed separately, and then review the new one as a first contact.
 */
export function HostKeyChangedDialog({ change, onForget, onClose }: HostKeyChangedDialogProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const target = change.port === 22 ? change.host : `${change.host}:${change.port}`

  return (
    <Dialog
      title="Warning: this server's identity has changed"
      tone="danger"
      onDismiss={onClose}
      actions={
        confirming ? (
          <>
            <button type="button" data-autofocus onClick={() => setConfirming(false)} className={SECONDARY_BUTTON}>
              Keep saved key
            </button>
            <button type="button" onClick={onForget} className={DANGER_BUTTON}>
              Forget saved key
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirming(true)} className={SECONDARY_BUTTON}>
              I know why it changed…
            </button>
            <button type="button" data-autofocus onClick={onClose} className={SECONDARY_BUTTON}>
              Close
            </button>
          </>
        )
      }
    >
      <p>
        <span className="font-medium text-zinc-200">{target}</span> presented a different key from the one you trusted
        before. Someone may be intercepting the connection, or the server may have been reinstalled.
      </p>
      <p className="text-zinc-300">{APP_NAME} did not connect, and your password was not sent.</p>
      <Fingerprint label="Trusted before" algorithm={change.saved.algorithm} fingerprint={change.saved.fingerprint} testId="host-key-saved" />
      <Fingerprint label="Presented now" algorithm={change.offered.algorithm} fingerprint={change.offered.fingerprint} testId="host-key-offered" />
      {confirming && (
        <p className="rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-red-200">
          Only forget the saved key if you know why it changed, for example because the server was rebuilt. You will
          be asked to verify the new key when you next connect.
        </p>
      )}
    </Dialog>
  )
}
