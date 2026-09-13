import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_PASSPHRASE, generateTestKeys, sshKeygenFingerprint, type TestKeySet } from '../../../test/support/ssh-keys'
import { AppError } from '../errors'
import { MAX_KEY_BYTES, classifyParseError, inspectPrivateKey, loadPrivateKey } from './private-keys'

const isRoot = process.getuid?.() === 0

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? `${error.code}: ${error.message}` : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

describe('private keys', () => {
  let set: TestKeySet

  beforeAll(async () => {
    set = await generateTestKeys()
  }, 60_000)

  afterAll(async () => {
    await set?.remove()
  })

  describe('classifyParseError pins the ssh2 messages Fly relies on', () => {
    it.each([
      ['Encrypted private OpenSSH key detected, but no passphrase given', 'passphrase-required'],
      ['Encrypted OpenSSH private key detected, but no passphrase given', 'passphrase-required'],
      ['OpenSSH key integrity check failed -- bad passphrase?', 'passphrase-incorrect'],
      ['Malformed OpenSSH private key. Bad passphrase?', 'passphrase-incorrect'],
      ['Unsupported key format', 'invalid']
    ])('%s → %s', (message, kind) => {
      expect(classifyParseError(message)).toBe(kind)
    })
  })

  describe('inspectPrivateKey', () => {
    it.each(['ed25519', 'rsa', 'ecdsa'] as const)('describes an unencrypted %s key with OpenSSH’s fingerprint', async (name) => {
      const key = set.keys[name]
      await chmod(key.path, 0o600)
      const info = await inspectPrivateKey(key.path, 'darwin')
      expect(info).toMatchObject({ encrypted: false, comment: `fly-test-${name}`, permissionsTooOpen: false })
      expect(info.fingerprint).toBe(await sshKeygenFingerprint(key.path))
      expect(info.algorithm).toMatch(name === 'ecdsa' ? /^ecdsa-sha2-/ : name === 'rsa' ? /^ssh-rsa$/ : /^ssh-ed25519$/)
    })

    it('describes an encrypted key from its .pub file, without the passphrase', async () => {
      const key = set.keys['ed25519-encrypted']
      const info = await inspectPrivateKey(key.path, 'darwin')
      expect(info).toMatchObject({ encrypted: true, algorithm: 'ssh-ed25519', comment: 'fly-test-ed25519-encrypted' })
      expect(info.fingerprint).toBe(await sshKeygenFingerprint(key.path))
    })

    it('still recognises an encrypted key when there is no .pub beside it', async () => {
      const lonely = join(set.dir, 'lonely')
      await copyFile(set.keys['ed25519-encrypted'].path, lonely)
      expect(await inspectPrivateKey(lonely, 'darwin')).toMatchObject({ encrypted: true, algorithm: null, fingerprint: null })
    })

    it('warns when others can read the key, except on Windows', async () => {
      const key = set.keys.ed25519
      await chmod(key.path, 0o644)
      expect((await inspectPrivateKey(key.path, 'darwin')).permissionsTooOpen).toBe(true)
      expect((await inspectPrivateKey(key.path, 'win32')).permissionsTooOpen).toBe(false)
      await chmod(key.path, 0o600)
    })

    it('says so when the public half was chosen', async () => {
      expect(await codeOf(inspectPrivateKey(`${set.keys.ed25519.path}.pub`))).toMatch(/^KEY_IS_PUBLIC: .*without \.pub/)
    })

    it('explains how to convert a PKCS#8 key', async () => {
      const path = set.keys['rsa-pkcs8'].path
      expect(await codeOf(inspectPrivateKey(path))).toBe(
        `KEY_INVALID: This key is in PKCS#8 format, which isn't supported. Convert it to OpenSSH format with: ssh-keygen -p -f "${path}"`
      )
    })

    it.each([
      ['a missing file', async (dir: string) => join(dir, 'nope'), 'KEY_NOT_FOUND'],
      ['a folder', async (dir: string) => {
        await mkdir(join(dir, 'a-folder'), { recursive: true })
        return join(dir, 'a-folder')
      }, 'KEY_INVALID'],
      ['something that is not a key', async (dir: string) => {
        await writeFile(join(dir, 'notes.txt'), 'hello')
        return join(dir, 'notes.txt')
      }, 'KEY_INVALID'],
      ['a file too large to be a key', async (dir: string) => {
        await writeFile(join(dir, 'huge'), Buffer.alloc(MAX_KEY_BYTES + 1, 0x41))
        return join(dir, 'huge')
      }, 'KEY_INVALID']
    ])('rejects %s', async (_label, make, code) => {
      expect(await codeOf(inspectPrivateKey(await make(set.dir)))).toMatch(new RegExp(`^${code}:`))
    })

    it.skipIf(isRoot)('reports an unreadable key file', async () => {
      const path = join(set.dir, 'unreadable')
      await copyFile(set.keys.ed25519.path, path)
      await chmod(path, 0o000)
      expect(await codeOf(inspectPrivateKey(path))).toMatch(/^KEY_UNREADABLE:/)
      await chmod(path, 0o600)
      await rm(path)
    })
  })

  describe('loadPrivateKey', () => {
    it('returns an unencrypted key', async () => {
      expect((await loadPrivateKey(set.keys.ed25519.path)).length).toBeGreaterThan(0)
    })

    it.each(['ed25519-encrypted', 'rsa-pem-encrypted'] as const)('needs, checks and accepts the passphrase for %s', async (name) => {
      const path = set.keys[name].path
      expect(await codeOf(loadPrivateKey(path))).toMatch(/^KEY_PASSPHRASE_REQUIRED:/)
      expect(await codeOf(loadPrivateKey(path, 'not it'))).toBe('KEY_PASSPHRASE_INCORRECT: The passphrase is incorrect for this key.')
      expect((await loadPrivateKey(path, TEST_PASSPHRASE)).length).toBeGreaterThan(0)
    })

    it('refuses a public key and unsupported formats', async () => {
      expect(await codeOf(loadPrivateKey(`${set.keys.rsa.path}.pub`))).toMatch(/^KEY_IS_PUBLIC:/)
      expect(await codeOf(loadPrivateKey(set.keys['rsa-pkcs8'].path))).toMatch(/^KEY_INVALID:/)
    })
  })
})
