import { IPC } from '../../shared/constants/channels'
import type { ConnectOutcome, ConnectRequest } from '../../shared/types/connection'
import type { DirectoryListing } from '../../shared/types/files'
import { AppError } from '../errors'
import type { ConnectionService } from '../services/connection.service'
import { handle } from './handle'
import {
  assertHost,
  assertObject,
  assertPort,
  assertRemotePath,
  assertString,
  assertUsername,
  assertUuid
} from './validate'

/** Rebuilds the request field by field, so nothing unexpected from the renderer reaches the service. */
function assertConnectRequest(value: unknown): ConnectRequest {
  const request = assertObject(value, 'request')
  const auth = assertObject(request['auth'], 'auth')
  if (auth['type'] !== 'password') {
    throw new AppError('INVALID_INPUT', 'Unsupported authentication type.')
  }
  return {
    host: assertHost(request['host']),
    port: assertPort(request['port']),
    username: assertUsername(request['username']),
    auth: { type: 'password', password: assertString(auth['password'], 'password', 1024) }
  }
}

/** Remote connections (Milestone 3). Close events are pushed from main.ts. */
export function registerSftpIpc(connections: ConnectionService): void {
  handle<ConnectOutcome>(IPC.SFTP_CONNECT, (request) => connections.connect(assertConnectRequest(request)))

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
