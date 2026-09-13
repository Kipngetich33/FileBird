import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostKeyStore, describeHostKey, hostKeyAlgorithm, hostKeyFingerprint, hostKeyId } from './host-keys'

// Generated with `ssh-keygen -t ed25519`; the fingerprint is what
// `ssh-keygen -lf` printed for it, so this checks against OpenSSH, not ourselves.
const ED25519_BLOB = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIL+WK19nFj1HtD6rGNBy0QNPm3X4T66kM+3LiYvnV0ba', 'base64')
const ED25519_FINGERPRINT = 'SHA256:jmr+beGxPaO9CseOlrdD5OEw5Ogm8RsAniWr0r/kqUQ'

const OTHER_BLOB = Buffer.concat([ED25519_BLOB.subarray(0, -1), Buffer.from([0x00])])

describe('fingerprints', () => {
  it('matches the fingerprint OpenSSH computes', () => {
    expect(hostKeyFingerprint(ED25519_BLOB)).toBe(ED25519_FINGERPRINT)
  })

  it('reads the algorithm name from the key blob', () => {
    expect(hostKeyAlgorithm(ED25519_BLOB)).toBe('ssh-ed25519')
    expect(describeHostKey(ED25519_BLOB)).toEqual({ algorithm: 'ssh-ed25519', fingerprint: ED25519_FINGERPRINT })
  })

  it.each([
    ['empty', Buffer.alloc(0)],
    ['truncated length', Buffer.from([0, 0, 0])],
    ['length past the end', Buffer.from([0, 0, 0, 40, 0x61])],
    ['zero length', Buffer.from([0, 0, 0, 0])]
  ])('reports a malformed blob (%s) as unknown instead of throwing', (_label, blob) => {
    expect(hostKeyAlgorithm(blob)).toBe('unknown')
  })

  it('keys hosts like known_hosts, case-insensitively', () => {
    expect(hostKeyId('Example.COM', 2222)).toBe('[example.com]:2222')
  })
})

describe('HostKeyStore', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-host-keys-'))
    file = join(dir, 'nested', 'known-hosts.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('knows nothing before anything is trusted', async () => {
    expect(await new HostKeyStore(file).lookup('example.com', 22)).toBeNull()
  })

  it('trusts, persists across instances, and forgets', async () => {
    await new HostKeyStore(file).trust('Example.com', 22, ED25519_BLOB)

    const reopened = new HostKeyStore(file)
    expect((await reopened.lookup('example.com', 22))?.equals(ED25519_BLOB)).toBe(true)
    expect(await reopened.lookup('example.com', 2222)).toBeNull()

    await reopened.forget('EXAMPLE.com', 22)
    expect(await new HostKeyStore(file).lookup('example.com', 22)).toBeNull()
  })

  it('stores the full key, so a different key is never mistaken for it', async () => {
    const store = new HostKeyStore(file)
    await store.trust('h', 22, ED25519_BLOB)
    expect((await store.lookup('h', 22))?.equals(OTHER_BLOB)).toBe(false)
  })

  it('keeps every write when trusts overlap', async () => {
    const store = new HostKeyStore(file)
    await Promise.all(['a', 'b', 'c', 'd'].map((host) => store.trust(host, 22, ED25519_BLOB)))
    for (const host of ['a', 'b', 'c', 'd']) expect(await store.lookup(host, 22)).not.toBeNull()
  })

  it('writes the file readable by the user only and leaves no temp files', async () => {
    await new HostKeyStore(file).trust('h', 22, ED25519_BLOB)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(join(dir, 'nested'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('sets a corrupt file aside instead of overwriting it', async () => {
    const store = new HostKeyStore(file)
    await store.trust('h', 22, ED25519_BLOB)
    await writeFile(file, '{ not json')

    expect(await store.lookup('h', 22)).toBeNull()
    const names = await readdir(join(dir, 'nested'))
    expect(names.some((name) => name.startsWith('known-hosts.json.corrupt-'))).toBe(true)
  })
})
