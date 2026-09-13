import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { KeyringSecretStore } from './keyring-secret-store'

const run = promisify(execFile)

// A namespace of its own, removed afterwards, so the real app's secrets are never touched.
const SERVICE = `Fly (test ${process.pid})`
const ACCOUNT = 'connection/00000000-0000-4000-8000-000000000000/password'

/**
 * Whether the Keychain holds an item, checked by attributes only. Reading the
 * value from another program (`security -w`) would make macOS show an access
 * dialog and hang the test, so values are checked through the store itself.
 */
async function existsInKeychain(account: string): Promise<boolean> {
  try {
    await run('security', ['find-generic-password', '-s', SERVICE, '-a', account], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'darwin')('KeyringSecretStore against the real macOS Keychain', () => {
  const store = new KeyringSecretStore(SERVICE)

  afterAll(async () => {
    await store.delete(ACCOUNT)
    await store.delete(`${ACCOUNT}-other`)
  })

  it('reports nothing for a secret that was never stored', async () => {
    expect(await store.get(ACCOUNT)).toBeNull()
    expect(await existsInKeychain(ACCOUNT)).toBe(false)
  })

  it('stores a secret as a real Keychain item and reads it back', async () => {
    await store.set(ACCOUNT, 'correct horse battery staple')
    expect(await existsInKeychain(ACCOUNT)).toBe(true)
    expect(await store.get(ACCOUNT)).toBe('correct horse battery staple')
  })

  it('overwrites rather than duplicating', async () => {
    await store.set(ACCOUNT, 'rotated value')
    expect(await store.get(ACCOUNT)).toBe('rotated value')
  })

  it('keeps accounts apart', async () => {
    await store.set(`${ACCOUNT}-other`, 'another')
    expect(await store.get(ACCOUNT)).toBe('rotated value')
    expect(await store.get(`${ACCOUNT}-other`)).toBe('another')
  })

  it('deletes the item, and deleting again is harmless', async () => {
    await store.delete(ACCOUNT)
    await store.delete(ACCOUNT)
    expect(await store.get(ACCOUNT)).toBeNull()
    expect(await existsInKeychain(ACCOUNT)).toBe(false)
  })

  it('handles non-ASCII secrets', async () => {
    await store.set(`${ACCOUNT}-other`, 'pässwörd 🔑 密码')
    expect(await store.get(`${ACCOUNT}-other`)).toBe('pässwörd 🔑 密码')
  })
})
