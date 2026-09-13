import { IPC } from '../../shared/constants/channels'
import type { ConnectOutcome } from '../../shared/types/connection'
import type { DirectoryListing } from '../../shared/types/files'
import type { ConnectionService } from '../services/connection.service'
import { handle } from './handle'
import { assertHost, assertPort, assertRemotePath, assertUuid } from './validate'

/**
 * Live remote connections. Connecting starts in connections.ipc.ts (saved or
 * unsaved); this covers what follows. Close events are pushed from main.ts.
 */
export function registerSftpIpc(connections: ConnectionService): void {
  handle<ConnectOutcome>(IPC.SFTP_TRUST_HOST_KEY_AND_CONNECT, (token) =>
    connections.trustHostKeyAndConnect(assertUuid(token, 'token'))
  )

  handle<void>(IPC.SFTP_FORGET_HOST_KEY, (host, port) =>
    connections.forgetHostKey(assertHost(host), assertPort(port))
  )

  handle<DirectoryListing>(IPC.SFTP_LIST_DIRECTORY, (connectionId, path) =>
    connections.list(assertUuid(connectionId, 'connectionId'), assertRemotePath(path, 'path'))
  )

  handle<void>(IPC.SFTP_DISCONNECT, (connectionId) =>
    connections.disconnect(assertUuid(connectionId, 'connectionId'))
  )
}
