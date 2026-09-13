import type { ConnectOutcome, ConnectionClosedEvent } from '@shared/types/connection'
import type { DirectoryListing } from '@shared/types/files'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Live remote connections. Connecting itself starts in connections.service. */
export const sftpService = {
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
