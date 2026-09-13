import { createHash } from 'node:crypto'
import type { HostKeyInfo } from '../../shared/types/connection'
import { JsonDocument } from '../storage/json-document'

/** OpenSSH's fingerprint format: SHA256 of the key blob, unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** The key blob starts with its algorithm name as an SSH string (uint32 length + bytes). */
export function hostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const length = key.readUInt32BE(0)
  if (length === 0 || length > 64 || key.length < 4 + length) return 'unknown'
  return key.toString('latin1', 4, 4 + length)
}

export function describeHostKey(key: Buffer): HostKeyInfo {
  return { algorithm: hostKeyAlgorithm(key), fingerprint: hostKeyFingerprint(key) }
}

/** Same bracketed form OpenSSH uses in known_hosts for non-default ports. */
export function hostKeyId(host: string, port: number): string {
  return `[${host.toLowerCase()}]:${port}`
}

interface StoredHostKey {
  algorithm: string
  /** The full public key blob, base64. Compared byte for byte, not by fingerprint. */
  key: string
  addedAt: string
}

interface StoreFile {
  version: 1
  hosts: Record<string, StoredHostKey>
}

function isStoredHostKey(value: unknown): value is StoredHostKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredHostKey).key === 'string' &&
    typeof (value as StoredHostKey).algorithm === 'string'
  )
}

function parseStore(value: unknown): StoreFile {
  const hosts = (value as { hosts?: unknown } | null)?.hosts
  if (typeof hosts !== 'object' || hosts === null) throw new Error('missing "hosts"')
  const store: StoreFile = { version: 1, hosts: {} }
  for (const [id, entry] of Object.entries(hosts)) {
    if (isStoredHostKey(entry)) store.hosts[id] = entry
  }
  return store
}

/** Host keys the user has chosen to trust, in a JSON file in the app's data folder. */
export class HostKeyStore {
  private readonly document: JsonDocument<StoreFile>

  constructor(filePath: string) {
    this.document = new JsonDocument({ path: filePath, empty: () => ({ version: 1, hosts: {} }), parse: parseStore })
  }

  async lookup(host: string, port: number): Promise<Buffer | null> {
    const entry = (await this.document.read()).hosts[hostKeyId(host, port)]
    return entry === undefined ? null : Buffer.from(entry.key, 'base64')
  }

  async trust(host: string, port: number, key: Buffer): Promise<void> {
    await this.document.update((store) => ({
      ...store,
      hosts: {
        ...store.hosts,
        [hostKeyId(host, port)]: {
          algorithm: hostKeyAlgorithm(key),
          key: key.toString('base64'),
          addedAt: new Date().toISOString()
        }
      }
    }))
  }

  async forget(host: string, port: number): Promise<void> {
    await this.document.update((store) => {
      const hosts = { ...store.hosts }
      delete hosts[hostKeyId(host, port)]
      return { ...store, hosts }
    })
  }
}
