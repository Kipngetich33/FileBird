import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../shared/types/connections'
import { ConnectionStorage, toStoredProfile } from './connection-storage'

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b',
  name: 'Production',
  host: 'example.com',
  port: 22,
  username: 'ubuntu',
  auth: { type: 'privateKey', privateKeyPath: '/Users/me/.ssh/id_ed25519' },
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  ...overrides
})

describe('ConnectionStorage', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fly-connections-store-'))
    file = join(dir, 'connections.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('saves, lists, gets, replaces and removes profiles, persisting across instances', async () => {
    const store = new ConnectionStorage(file)
    await store.save(profile())
    await store.save(profile({ id: '00000000-0000-4000-8000-000000000001', name: 'Staging', auth: { type: 'password' } }))
    await store.save(profile({ name: 'Production (renamed)' }))

    const reopened = new ConnectionStorage(file)
    expect((await reopened.list()).map((p) => p.name)).toEqual(['Production (renamed)', 'Staging'])
    expect((await reopened.get(profile().id))?.auth).toEqual({ type: 'privateKey', privateKeyPath: '/Users/me/.ssh/id_ed25519' })

    await reopened.remove(profile().id)
    expect((await new ConnectionStorage(file).list()).map((p) => p.name)).toEqual(['Staging'])
    expect(await reopened.get('missing')).toBeNull()
  })

  it('never writes a secret, even if one is smuggled into the object', async () => {
    const smuggled = { ...profile(), password: 'hunter2', auth: { type: 'password', password: 'hunter2' }, passphrase: 'swordfish' }
    await new ConnectionStorage(file).save(smuggled as unknown as ConnectionProfile)

    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('swordfish')
    expect(text).not.toMatch(/password"\s*:|passphrase/)
  })

  it('writes owner-only and atomically', async () => {
    await new ConnectionStorage(file).save(profile())
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps every write when saves overlap', async () => {
    const store = new ConnectionStorage(file)
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
    await Promise.all(ids.map((id) => store.save(profile({ id }))))
    expect((await store.list()).map((p) => p.id).sort()).toEqual(ids)
  })

  it('sets aside a corrupt file and skips malformed entries', async () => {
    await writeFile(file, '{ not json')
    expect(await new ConnectionStorage(file).list()).toEqual([])
    expect((await readdir(dir)).some((name) => name.startsWith('connections.json.corrupt-'))).toBe(true)

    await writeFile(file, JSON.stringify({ version: 1, connections: [profile(), { id: 'broken' }, 'nonsense'] }))
    expect((await new ConnectionStorage(file).list()).map((p) => p.id)).toEqual([profile().id])
  })
})

describe('toStoredProfile', () => {
  it('keeps the ssh-config origin and drops unknown auth types', () => {
    expect(toStoredProfile({ ...profile(), importedFrom: { kind: 'ssh-config', alias: 'web' } })?.importedFrom).toEqual({
      kind: 'ssh-config',
      alias: 'web'
    })
    expect(toStoredProfile({ ...profile(), auth: { type: 'agent' } })).toBeNull()
    expect(toStoredProfile({ ...profile(), port: '22' })).toBeNull()
  })
})
