import type { ConnectOutcome, ConnectRequest, ConnectionClosedEvent } from '@shared/types/connection'
import type { DirectoryListing } from '@shared/types/files'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Renderer-side wrapper around the bridged SFTP API. Connections themselves live in the main process. */
export const sftpService = {
  connect: (request: ConnectRequest): Promise<ConnectOutcome> => call(() => window.api.sftp.connect(request)),

  trustHostKeyAndConnect: (token: string): Promise<ConnectOutcome> =>
    call(() => window.api.sftp.trustHostKeyAndConnect(token)),

  forgetHostKey: (host: string, port: number): Promise<void> =>
    call(() => window.api.sftp.forgetHostKey(host, port)),

  listDirectory: (connectionId: string, path: string): Promise<DirectoryListing> =>
    call(() => window.api.sftp.listDirectory(connectionId, path)),

  disconnect: (connectionId: string): Promise<void> => call(() => window.api.sftp.disconnect(connectionId)),

  /** Returns an unsubscribe function. */
  onConnectionClosed: (listener: (event: ConnectionClosedEvent) => void): (() => void) =>
    window.api.sftp.onConnectionClosed(listener)
}
