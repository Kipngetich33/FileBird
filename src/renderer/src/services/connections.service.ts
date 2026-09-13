import type { ConnectOutcome } from '@shared/types/connection'
import type {
  ConnectionInput,
  ConnectionSummary,
  ImportPreview,
  KeyInfo,
  SecretEntry
} from '@shared/types/connections'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Saved connections, key files and SSH config import. Secrets are handled in the main process. */
export const connectionsService = {
  list: (): Promise<ConnectionSummary[]> => call(() => window.api.connections.list()),
  create: (input: ConnectionInput): Promise<ConnectionSummary> => call(() => window.api.connections.create(input)),
  update: (id: string, input: ConnectionInput): Promise<ConnectionSummary> =>
    call(() => window.api.connections.update(id, input)),
  remove: (id: string): Promise<void> => call(() => window.api.connections.delete(id)),
  forgetSecret: (id: string): Promise<void> => call(() => window.api.connections.forgetSecret(id)),
  connect: (id: string, secret?: SecretEntry): Promise<ConnectOutcome> =>
    call(() => window.api.connections.connect(id, secret)),
  connectUnsaved: (input: ConnectionInput, secret?: SecretEntry): Promise<ConnectOutcome> =>
    call(() => window.api.connections.connectUnsaved(input, secret)),

  pickKey: (): Promise<string | null> => call(() => window.api.keys.pick()),
  inspectKey: (path: string): Promise<KeyInfo> => call(() => window.api.keys.inspect(path)),

  previewImport: (allowCommands: boolean): Promise<ImportPreview> =>
    call(() => window.api.sshConfig.preview({ allowCommands })),
  importHosts: (aliases: string[], allowCommands: boolean): Promise<ConnectionSummary[]> =>
    call(() => window.api.sshConfig.import(aliases, { allowCommands }))
}
