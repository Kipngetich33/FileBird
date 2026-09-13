import { useMemo, type JSX } from 'react'
import type { ConnectionInfo } from '@shared/types/connection'
import { ConnectForm } from '@renderer/components/Connection/ConnectForm'
import { HostKeyChangedDialog } from '@renderer/components/Connection/HostKeyChangedDialog'
import { HostKeyDialog } from '@renderer/components/Connection/HostKeyDialog'
import { useDirectory, type DirectorySource } from '@renderer/hooks/useDirectory'
import type { RemoteConnectionState } from '@renderer/hooks/useRemoteConnection'
import { sftpService } from '@renderer/services/sftp.service'
import { FilePane } from './FilePane'

/** The right-hand pane: a connect form until connected, then the remote file browser. */
export function RemotePane({ remote }: { remote: RemoteConnectionState }): JSX.Element {
  return (
    <>
      {remote.connection !== null ? (
        // Keyed by connection, so a new connection starts with fresh browsing state.
        <ConnectedPane key={remote.connection.id} connection={remote.connection} onDisconnect={remote.disconnect} />
      ) : (
        <section
          aria-label="Remote connection"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-[#11141b]"
        >
          <div className="flex h-10 shrink-0 items-center border-b border-white/[0.06] px-3">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Remote</span>
          </div>
          <div className="flex min-h-0 flex-1 items-center overflow-y-auto p-6">
            <ConnectForm
              // Remount with the last target after a disconnect or a lost connection.
              key={remote.lastTarget === null ? 'blank' : `${remote.lastTarget.username}@${remote.lastTarget.host}:${remote.lastTarget.port}`}
              initial={remote.lastTarget}
              busy={remote.phase === 'connecting'}
              error={remote.error}
              notice={remote.notice}
              onSubmit={(request) => void remote.connect(request)}
              onDismissError={remote.dismissError}
            />
          </div>
        </section>
      )}

      {remote.hostKeyPrompt !== null && (
        <HostKeyDialog
          prompt={remote.hostKeyPrompt}
          onTrust={() => void remote.trustHostKey()}
          onCancel={remote.cancelHostKey}
        />
      )}

      {remote.hostKeyChange !== null && (
        <HostKeyChangedDialog
          change={remote.hostKeyChange}
          onForget={() => void remote.forgetChangedHostKey()}
          onClose={remote.dismissHostKeyChange}
        />
      )}
    </>
  )
}

interface ConnectedPaneProps {
  connection: ConnectionInfo
  onDisconnect: () => Promise<void>
}

function ConnectedPane({ connection, onDisconnect }: ConnectedPaneProps): JSX.Element {
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
