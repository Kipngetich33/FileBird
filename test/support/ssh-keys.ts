import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Throwaway SSH keys generated with ssh-keygen for each test run, so no private
 * key is ever committed to the repository.
 */

const run = promisify(execFile)

export const TEST_PASSPHRASE = 'correct horse battery staple'

const SPECS = {
  ed25519: { args: ['-t', 'ed25519'], encrypted: false },
  rsa: { args: ['-t', 'rsa', '-b', '3072'], encrypted: false },
  ecdsa: { args: ['-t', 'ecdsa', '-b', '256'], encrypted: false },
  'ed25519-encrypted': { args: ['-t', 'ed25519'], encrypted: true },
  'rsa-pem-encrypted': { args: ['-t', 'rsa', '-b', '2048', '-m', 'PEM'], encrypted: true },
  'rsa-pkcs8': { args: ['-t', 'rsa', '-b', '2048', '-m', 'PKCS8'], encrypted: false },
  /** A valid key that no test server authorises. */
  unauthorised: { args: ['-t', 'ed25519'], encrypted: false }
} as const

export type TestKeyName = keyof typeof SPECS

export interface TestKey {
  name: TestKeyName
  path: string
  publicKey: string
  passphrase: string | undefined
}

export interface TestKeySet {
  dir: string
  keys: Record<TestKeyName, TestKey>
  remove(): Promise<void>
}

export async function generateTestKeys(): Promise<TestKeySet> {
  const dir = await mkdtemp(join(tmpdir(), 'fly-test-keys-'))
  const keys = {} as Record<TestKeyName, TestKey>

  for (const [name, spec] of Object.entries(SPECS) as Array<[TestKeyName, (typeof SPECS)[TestKeyName]]>) {
    const path = join(dir, name)
    const passphrase = spec.encrypted ? TEST_PASSPHRASE : undefined
    await run('ssh-keygen', ['-q', ...spec.args, '-N', passphrase ?? '', '-C', `fly-test-${name}`, '-f', path])
    keys[name] = { name, path, publicKey: (await readFile(`${path}.pub`, 'utf8')).trim(), passphrase }
  }

  return {
    dir,
    keys,
    remove: () => rm(dir, { recursive: true, force: true })
  }
}

/** OpenSSH's own fingerprint for a key file. */
export async function sshKeygenFingerprint(path: string): Promise<string> {
  const { stdout } = await run('ssh-keygen', ['-lf', path])
  const fingerprint = stdout.split(' ')[1]
  if (fingerprint === undefined) throw new Error(`ssh-keygen printed no fingerprint for ${path}`)
  return fingerprint
}
