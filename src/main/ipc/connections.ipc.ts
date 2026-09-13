import { IPC } from '../../shared/constants/channels'
import type { ConnectOutcome } from '../../shared/types/connection'
import type {
  ConnectionInput,
  ConnectionSummary,
  ImportPreview,
  KeyInfo,
  ProfileAuth,
  SecretEntry
} from '../../shared/types/connections'
import { AppError } from '../errors'
import type { ConnectionProfilesService } from '../services/connection-profiles.service'
import type { SshConfigImportService } from '../services/ssh-config-import.service'
import { inspectPrivateKey } from '../ssh/private-keys'
import { handle } from './handle'
import {
  assertAbsolutePath,
  assertBoolean,
  assertHost,
  assertName,
  assertObject,
  assertPort,
  assertString,
  assertUsername,
  assertUuid
} from './validate'

/** Every object from the renderer is rebuilt field by field; nothing unexpected reaches a service. */
function assertAuth(value: unknown): ProfileAuth {
  const auth = assertObject(value, 'auth')
  if (auth['type'] === 'password') return { type: 'password' }
  if (auth['type'] === 'privateKey') {
    return { type: 'privateKey', privateKeyPath: assertAbsolutePath(auth['privateKeyPath'], 'privateKeyPath') }
  }
  throw new AppError('INVALID_INPUT', 'Unsupported authentication type.')
}

function assertConnectionInput(value: unknown, { allowEmptyName = false } = {}): ConnectionInput {
  const input = assertObject(value, 'connection')
  const host = assertHost(input['host'])
  const name = assertName(input['name'], 'name', { allowEmpty: allowEmptyName })
  return {
    name: name === '' ? host : name,
    host,
    port: assertPort(input['port']),
    username: assertUsername(input['username']),
    auth: assertAuth(input['auth'])
  }
}

function assertSecret(value: unknown): SecretEntry | undefined {
  if (value === undefined || value === null) return undefined
  const secret = assertObject(value, 'secret')
  return {
    value: assertString(secret['value'], 'secret', 1024),
    remember: assertBoolean(secret['remember'], 'remember')
  }
}

function assertAliases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new AppError('INVALID_INPUT', 'Expected a list of host aliases.')
  return value.map((alias) => {
    const text = assertString(alias, 'alias', 255)
    if (text === '' || /\s/.test(text) || text.startsWith('-')) throw new AppError('INVALID_INPUT', 'Invalid host alias.')
    return text
  })
}

const allowCommandsOf = (value: unknown): boolean => assertBoolean(assertObject(value, 'options')['allowCommands'], 'allowCommands')

export interface ConnectionsIpcDependencies {
  profiles: ConnectionProfilesService
  imports: SshConfigImportService
  /** Opens the native file dialog; resolves null if cancelled. */
  pickPrivateKey: () => Promise<string | null>
}

/** Saved connections, private keys and SSH config import (Milestone 4). */
export function registerConnectionsIpc({ profiles, imports, pickPrivateKey }: ConnectionsIpcDependencies): void {
  handle<ConnectionSummary[]>(IPC.CONNECTIONS_LIST, () => profiles.list())

  handle<ConnectionSummary>(IPC.CONNECTIONS_CREATE, (input) => profiles.create(assertConnectionInput(input)))

  handle<ConnectionSummary>(IPC.CONNECTIONS_UPDATE, (id, input) =>
    profiles.update(assertUuid(id, 'id'), assertConnectionInput(input))
  )

  handle<void>(IPC.CONNECTIONS_DELETE, (id) => profiles.delete(assertUuid(id, 'id')))

  handle<void>(IPC.CONNECTIONS_FORGET_SECRET, (id) => profiles.forgetSecret(assertUuid(id, 'id')))

  handle<ConnectOutcome>(IPC.CONNECTIONS_CONNECT, (id, secret) =>
    profiles.connect(assertUuid(id, 'id'), assertSecret(secret))
  )

  handle<ConnectOutcome>(IPC.CONNECTIONS_CONNECT_UNSAVED, (input, secret) =>
    profiles.connectUnsaved(assertConnectionInput(input, { allowEmptyName: true }), assertSecret(secret))
  )

  handle<string | null>(IPC.KEYS_PICK, () => pickPrivateKey())

  handle<KeyInfo>(IPC.KEYS_INSPECT, (path) => inspectPrivateKey(assertAbsolutePath(path, 'path')))

  handle<ImportPreview>(IPC.SSH_CONFIG_PREVIEW, (options) => imports.preview(allowCommandsOf(options)))

  handle<ConnectionSummary[]>(IPC.SSH_CONFIG_IMPORT, (aliases, options) =>
    imports.import(assertAliases(aliases), allowCommandsOf(options))
  )
}
