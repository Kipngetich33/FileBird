import type { JSX } from 'react'
import type { HostKeyPrompt } from '@renderer/hooks/useRemoteConnection'
import { Dialog, Fingerprint, PRIMARY_BUTTON, SECONDARY_BUTTON } from './Dialog'
import { APP_NAME } from '@shared/constants/app'

interface HostKeyDialogProps {
  prompt: HostKeyPrompt
  onTrust: () => void
  onCancel: () => void
}

/** Where OpenSSH keeps the public half of this key type on a typical server. */
function hostKeyFileFor(algorithm: string): string {
  if (algorithm === 'ssh-ed25519') return '/etc/ssh/ssh_host_ed25519_key.pub'
  if (algorithm.startsWith('ecdsa-')) return '/etc/ssh/ssh_host_ecdsa_key.pub'
  if (algorithm === 'ssh-rsa' || algorithm.startsWith('rsa-')) return '/etc/ssh/ssh_host_rsa_key.pub'
  return '/etc/ssh/ssh_host_*_key.pub'
}

/** First contact with a server: the user decides whether this key really is theirs. */
export function HostKeyDialog({ prompt, onTrust, onCancel }: HostKeyDialogProps): JSX.Element {
  const target = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`

  return (
    <Dialog
      title="Verify this server"
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" data-autofocus onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={onTrust} className={PRIMARY_BUTTON}>
            Trust and connect
          </button>
        </>
      }
    >
      <p>
        This is the first time {APP_NAME} has connected to <span className="font-medium text-zinc-200">{target}</span>. Check
        that this fingerprint matches the server's before trusting it.
      </p>
      <Fingerprint
        label="Host key"
        algorithm={prompt.hostKey.algorithm}
        fingerprint={prompt.hostKey.fingerprint}
        testId="host-key-fingerprint"
      />
      <p className="text-[11px] text-zinc-500">
        On the server, <span className="font-mono">ssh-keygen -lf {hostKeyFileFor(prompt.hostKey.algorithm)}</span>{' '}
        prints it.
        {APP_NAME} will remember this key and warn you if it ever changes.
      </p>
    </Dialog>
  )
}
