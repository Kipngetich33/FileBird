import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HostKeyInfo } from '../../shared/types/connection'
import { errnoOf } from '../errors'
import { createLogger } from '../logger'

const log = createLogger('host-keys')

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

const emptyStore = (): StoreFile => ({ version: 1, hosts: {} })

function isStoredHostKey(value: unknown): value is StoredHostKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredHostKey).key === 'string' &&
    typeof (value as StoredHostKey).algorithm === 'string'
  )
}

/**
 * Host keys the user has chosen to trust, in a JSON file in the app's data
 * folder. Writes are serialised and atomic (temp file + rename), so a crash
 * mid-write cannot leave a half-written trust store.
 */
export class HostKeyStore {
  private readonly filePath: string
  private pending: Promise<unknown> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async lookup(host: string, port: number): Promise<Buffer | null> {
    await this.pending
    const entry = (await this.read()).hosts[hostKeyId(host, port)]
    return entry === undefined ? null : Buffer.from(entry.key, 'base64')
  }

  trust(host: string, port: number, key: Buffer): Promise<void> {
    return this.update((hosts) => {
      hosts[hostKeyId(host, port)] = {
        algorithm: hostKeyAlgorithm(key),
        key: key.toString('base64'),
        addedAt: new Date().toISOString()
      }
    })
  }

  forget(host: string, port: number): Promise<void> {
    return this.update((hosts) => {
      delete hosts[hostKeyId(host, port)]
    })
  }

  private update(change: (hosts: Record<string, StoredHostKey>) => void): Promise<void> {
    const run = this.pending.then(async () => {
      const store = await this.read()
      change(store.hosts)
      await this.write(store)
    })
    // A failed write must not wedge every later one.
    this.pending = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<StoreFile> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return emptyStore()
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(text)
      const hosts = (parsed as { hosts?: unknown } | null)?.hosts
      if (typeof hosts !== 'object' || hosts === null) throw new Error('missing "hosts"')
      const store = emptyStore()
      for (const [id, entry] of Object.entries(hosts)) {
        if (isStoredHostKey(entry)) store.hosts[id] = entry
      }
      return store
    } catch (error) {
      // Keep the damaged file for inspection rather than silently overwriting
      // it. The user is simply asked to confirm keys again.
      const aside = `${this.filePath}.corrupt-${Date.now()}`
      await rename(this.filePath, aside).catch(() => undefined)
      log.warn('Trust store was unreadable and has been set aside', {
        aside,
        error: error instanceof Error ? error.message : String(error)
      })
      return emptyStore()
    }
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.filePath)
  }
}
