import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ConnectionInfo } from '@shared/types/connection'
import type { ConnectionInput, ConnectionSummary } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'
import { ConfirmDialog } from '@renderer/components/Connection/ConfirmDialog'
import { ConnectionForm } from '@renderer/components/Connection/ConnectionForm'
import { ConnectionList } from '@renderer/components/Connection/ConnectionList'
import { HostKeyChangedDialog } from '@renderer/components/Connection/HostKeyChangedDialog'
import { HostKeyDialog } from '@renderer/components/Connection/HostKeyDialog'
import { ImportDialog } from '@renderer/components/Connection/ImportDialog'
import { SecretPrompt } from '@renderer/components/Connection/SecretPrompt'
import { useConnectionProfiles } from '@renderer/hooks/useConnectionProfiles'
import { useDirectory, type DirectorySource } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
import { connectionsService } from '@renderer/services/connections.service'
import { sftpService } from '@renderer/services/sftp.service'
import { FilePane } from './FilePane'

type View = { name: 'list' } | { name: 'new' } | { name: 'edit'; profile: ConnectionSummary }

const toInput = (profile: ConnectionSummary): ConnectionInput => ({
  name: profile.name,
  host: profile.host,
  port: profile.port,
  username: profile.username,
  auth: profile.auth
})

/** The right-hand pane: saved connections until connected, then the remote file browser. */
export function RemotePane({ remote }: { remote: RemoteConnectionState }): JSX.Element {
  const saved = useConnectionProfiles()
  const [view, setView] = useState<View>({ name: 'list' })
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState<ConnectionSummary | null>(null)
  const [formError, setFormError] = useState<AppErrorPayload | null>(null)
  const [listNotice, setListNotice] = useState<string | null>(null)

  const { reload } = saved
  const connectionId = remote.connection?.id ?? null
  // Saved-secret badges change after a successful connect or a disconnect.
  useEffect(() => {
    void reload()
  }, [reload, connectionId])

  const busy = remote.phase === 'connecting'

  async function save(input: ConnectionInput, then: 'list' | 'connect'): Promise<void> {
    setFormError(null)
    try {
      const profile =
        view.name === 'edit' ? await connectionsService.update(view.profile.id, input) : await connectionsService.create(input)
      await reload()
      setView({ name: 'list' })
      if (then === 'connect') await remote.connectSaved(profile)
    } catch (cause) {
      setFormError(cause as AppErrorPayload)
    }
  }

  async function forgetSecret(profile: ConnectionSummary): Promise<void> {
    try {
      await connectionsService.forgetSecret(profile.id)
      setListNotice(`Forgot the saved ${profile.savedSecret ?? 'secret'} for "${profile.name}".`)
    } catch (cause) {
      setFormError(cause as AppErrorPayload)
    }
    await reload()
  }

  async function confirmDelete(profile: ConnectionSummary): Promise<void> {
    setDeleting(null)
    try {
      await connectionsService.remove(profile.id)
      setListNotice(`Deleted "${profile.name}".`)
    } catch (cause) {
      setFormError(cause as AppErrorPayload)
    }
    await reload()
  }

  const unsavedInitial = remote.lastTarget?.kind === 'unsaved' ? remote.lastTarget.input : null
  const promptKey = useRequestKey(remote.secretRequest)

  return (
    <>
      {remote.connection !== null ? (
        // Keyed by connection, so a new connection starts with fresh browsing state.
        <ConnectedPane
          key={remote.connection.id}
          connection={remote.connection}
          onDisconnect={remote.disconnect}
          notice={remote.notice}
          onDismissNotice={remote.dismissNotice}
        />
      ) : (
        <section
          aria-label="Remote connection"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-[#11141b]"
        >
          <div className="flex h-10 shrink-0 items-center border-b border-white/[0.06] px-3">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Remote</span>
          </div>
          <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
            <div className="m-auto w-full">
              {view.name === 'list' ? (
                <ConnectionList
                  profiles={saved.profiles}
                  loading={saved.loading}
                  busy={busy}
                  error={remote.error ?? saved.error ?? formError}
                  notice={remote.notice ?? listNotice}
                  onConnect={(profile) => {
                    setListNotice(null)
                    void remote.connectSaved(profile)
                  }}
                  onEdit={(profile) => {
                    setFormError(null)
                    setView({ name: 'edit', profile })
                  }}
                  onDelete={setDeleting}
                  onForgetSecret={(profile) => void forgetSecret(profile)}
                  onNew={() => {
                    setFormError(null)
                    setView({ name: 'new' })
                  }}
                  onImport={() => setImporting(true)}
                  onDismissError={() => {
                    remote.dismissError()
                    setFormError(null)
                  }}
                />
              ) : (
                <ConnectionForm
                  key={view.name === 'edit' ? view.profile.id : 'new'}
                  mode={view.name}
                  initial={view.name === 'edit' ? toInput(view.profile) : unsavedInitial}
                  busy={busy}
                  error={formError ?? remote.error}
                  onCancel={() => setView({ name: 'list' })}
                  onSave={(input) => void save(input, 'list')}
                  onSaveAndConnect={(input) => void save(input, 'connect')}
                  onConnectUnsaved={(input) => void remote.connectUnsaved(input)}
                  onDismissError={() => {
                    setFormError(null)
                    remote.dismissError()
                  }}
                />
              )}
            </div>
          </div>
        </section>
      )}

      {remote.secretRequest !== null && (
        <SecretPrompt
          // A fresh, empty prompt for each new request (a retry after rejection
          // is a new request), but never on an ordinary re-render mid-typing.
          key={promptKey}
          request={remote.secretRequest}
          busy={busy}
          onSubmit={(secret) => void remote.submitSecret(secret)}
          onCancel={remote.cancelSecret}
        />
      )}

      {remote.hostKeyPrompt !== null && (
        <HostKeyDialog prompt={remote.hostKeyPrompt} onTrust={() => void remote.trustHostKey()} onCancel={remote.cancelHostKey} />
      )}

      {remote.hostKeyChange !== null && (
        <HostKeyChangedDialog
          change={remote.hostKeyChange}
          onForget={() => void remote.forgetChangedHostKey()}
          onClose={remote.dismissHostKeyChange}
        />
      )}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(count) => {
            setImporting(false)
            setListNotice(count === 1 ? 'Imported 1 connection.' : `Imported ${count} connections.`)
            setView({ name: 'list' })
            void reload()
          }}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          message="The saved connection is removed, together with any password or passphrase saved for it in your keychain."
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}

/** A number that changes only when a different request object arrives. */
function useRequestKey(request: object | null): number {
  const seen = useRef<{ request: object | null; key: number }>({ request: null, key: 0 })
  if (seen.current.request !== request) seen.current = { request, key: seen.current.key + 1 }
  return seen.current.key
}

interface ConnectedPaneProps {
  connection: ConnectionInfo
  onDisconnect: () => Promise<void>
  notice: string | null
  onDismissNotice: () => void
}

function ConnectedPane({ connection, onDisconnect, notice, onDismissNotice }: ConnectedPaneProps): JSX.Element {
  const source = useMemo<DirectorySource>(
    () => ({
      getStartDirectory: () => Promise.resolve(connection.homePath),
      listDirectory: (path) => sftpService.listDirectory(connection.id, path)
    }),
    [connection]
  )
  const directory = useDirectory(source)
  const where = connection.port === 22 ? connection.host : `${connection.host}:${connection.port}`

  return (
    <FilePane
      title="Remote"
      subtitle={`${connection.username}@${where}`}
      directory={directory}
      notice={notice}
      onDismissNotice={onDismissNotice}
      actions={
        <button
          type="button"
          onClick={() => void onDisconnect()}
          className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-100"
        >
          Disconnect
        </button>
      }
    />
  )
}
