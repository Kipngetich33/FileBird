import type { ConnectionProfile, ProfileAuth } from '../../shared/types/connections'
import { createLogger } from '../logger'
import { JsonDocument } from './json-document'

const log = createLogger('storage')

interface StoreFile {
  version: 1
  connections: ConnectionProfile[]
}

const isString = (value: unknown): value is string => typeof value === 'string'

function parseAuth(value: unknown): ProfileAuth | null {
  if (typeof value !== 'object' || value === null) return null
  const auth = value as Record<string, unknown>
  if (auth['type'] === 'password') return { type: 'password' }
  if (auth['type'] === 'privateKey' && isString(auth['privateKeyPath'])) {
    return { type: 'privateKey', privateKeyPath: auth['privateKeyPath'] }
  }
  return null
}

/**
 * Rebuilds a profile field by field. Anything not listed here, including any
 * secret that somehow found its way into an object, is never read or written.
 */
export function toStoredProfile(value: unknown): ConnectionProfile | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const auth = parseAuth(raw['auth'])
  const { id, name, host, port, username, createdAt, updatedAt } = raw
  if (
    !isString(id) || !isString(name) || !isString(host) || !isString(username) ||
    typeof port !== 'number' || !Number.isInteger(port) || auth === null ||
    !isString(createdAt) || !isString(updatedAt)
  ) {
    return null
  }

  const profile: ConnectionProfile = { id, name, host, port, username, auth, createdAt, updatedAt }
  const importedFrom = raw['importedFrom'] as Record<string, unknown> | undefined
  if (importedFrom?.['kind'] === 'ssh-config' && isString(importedFrom['alias'])) {
    profile.importedFrom = { kind: 'ssh-config', alias: importedFrom['alias'] }
  }
  return profile
}

function parseStore(value: unknown): StoreFile {
  const list = (value as { connections?: unknown } | null)?.connections
  if (!Array.isArray(list)) throw new Error('missing "connections"')
  const connections: ConnectionProfile[] = []
  for (const entry of list) {
    const profile = toStoredProfile(entry)
    if (profile === null) log.warn('Skipped a malformed saved connection')
    else connections.push(profile)
  }
  return { version: 1, connections }
}

/** Saved connections (spec section 9's connections.json): metadata only, never secrets. */
export class ConnectionStorage {
  private readonly document: JsonDocument<StoreFile>

  constructor(filePath: string) {
    this.document = new JsonDocument({ path: filePath, empty: () => ({ version: 1, connections: [] }), parse: parseStore })
  }

  async list(): Promise<ConnectionProfile[]> {
    return (await this.document.read()).connections
  }

  async get(id: string): Promise<ConnectionProfile | null> {
    return (await this.list()).find((profile) => profile.id === id) ?? null
  }

  /** Inserts, or replaces the profile with the same id. */
  async save(profile: ConnectionProfile): Promise<void> {
    const clean = toStoredProfile(profile)
    if (clean === null) throw new Error('Refusing to store an invalid connection profile')
    await this.document.update((store) => {
      const exists = store.connections.some((existing) => existing.id === clean.id)
      const connections = exists
        ? store.connections.map((existing) => (existing.id === clean.id ? clean : existing))
        : [...store.connections, clean]
      return { ...store, connections }
    })
  }

  async remove(id: string): Promise<void> {
    await this.document.update((store) => ({
      ...store,
      connections: store.connections.filter((profile) => profile.id !== id)
    }))
  }
}
