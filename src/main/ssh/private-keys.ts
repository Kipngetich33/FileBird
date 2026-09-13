import { readFile, stat } from 'node:fs/promises'
import { utils, type ParsedKey } from 'ssh2'
import type { KeyInfo } from '../../shared/types/connections'
import { AppError, errnoOf } from '../errors'
import { hostKeyFingerprint } from '../sftp/host-keys'
import { APP_NAME } from '../../shared/constants/app'

/**
 * Private key files, read only in the main process.
 *
 * Keys are parsed here *before* connecting. ssh2 silently skips a key it can't
 * decrypt and then reports the same "authentication failed" a server rejection
 * would, so a wrong passphrase must be caught locally to be reported as one.
 */

/** Far larger than any real SSH private key (RSA 16384 is ~13 KiB). */
export const MAX_KEY_BYTES = 64 * 1024

type ParseFailure = 'passphrase-required' | 'passphrase-incorrect' | 'invalid'

/** ssh2's messages (pinned by tests) for the cases a user can act on. */
export function classifyParseError(message: string): ParseFailure {
  if (/no passphrase given/i.test(message)) return 'passphrase-required'
  if (/bad passphrase/i.test(message)) return 'passphrase-incorrect'
  return 'invalid'
}

function isPkcs8(data: Buffer): boolean {
  const head = data.toString('latin1', 0, Math.min(data.length, 64))
  return head.includes('-----BEGIN PRIVATE KEY-----') || head.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')
}

async function readKeyFile(path: string): Promise<{ data: Buffer; mode: number }> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const errno = errnoOf(error)
    if (errno === 'ENOENT' || errno === 'ENOTDIR') throw new AppError('KEY_NOT_FOUND', `There's no key file at "${path}".`)
    if (errno === 'EACCES' || errno === 'EPERM') {
      throw new AppError('KEY_UNREADABLE', `${APP_NAME} can't read "${path}". Check the file's permissions.`)
    }
    throw error
  }
  if (!info.isFile()) throw new AppError('KEY_INVALID', `"${path}" isn't a file.`)
  if (info.size > MAX_KEY_BYTES) throw new AppError('KEY_INVALID', `"${path}" is too large to be a private key.`)

  try {
    return { data: await readFile(path), mode: info.mode }
  } catch (error) {
    const errno = errnoOf(error)
    if (errno === 'EACCES' || errno === 'EPERM') {
      throw new AppError('KEY_UNREADABLE', `${APP_NAME} can't read "${path}". Check the file's permissions.`)
    }
    throw error
  }
}

function invalidKey(path: string, data: Buffer): AppError {
  if (isPkcs8(data)) {
    return new AppError(
      'KEY_INVALID',
      `This key is in PKCS#8 format, which isn't supported. Convert it to OpenSSH format with: ssh-keygen -p -f "${path}"`
    )
  }
  return new AppError('KEY_INVALID', `"${path}" isn't a supported private key.`)
}

const publicKeyError = (): AppError =>
  new AppError('KEY_IS_PUBLIC', "That's a public key. Choose the private key file (the one without .pub).")

function firstKey(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(parsed) ? (parsed[0] ?? new Error('Unsupported key format')) : parsed
}

/** OpenSSH refuses keys that others can read; Fly warns but doesn't block (Windows modes differ). */
function tooOpen(mode: number, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && (mode & 0o077) !== 0
}

/** The public half of an encrypted key, from the `.pub` file beside it, if there is one. */
async function siblingPublicKey(path: string): Promise<ParsedKey | null> {
  try {
    const parsed = firstKey(utils.parseKey(await readFile(`${path}.pub`)))
    return parsed instanceof Error ? null : parsed
  } catch {
    return null
  }
}

/** What the connection form shows about a chosen key. Never includes key material. */
export async function inspectPrivateKey(path: string, platform: NodeJS.Platform = process.platform): Promise<KeyInfo> {
  const { data, mode } = await readKeyFile(path)
  const parsed = firstKey(utils.parseKey(data))
  const permissionsTooOpen = tooOpen(mode, platform)

  if (parsed instanceof Error) {
    if (classifyParseError(parsed.message) !== 'passphrase-required') throw invalidKey(path, data)
    const publicKey = await siblingPublicKey(path)
    return {
      encrypted: true,
      algorithm: publicKey?.type ?? null,
      fingerprint: publicKey === null ? null : hostKeyFingerprint(publicKey.getPublicSSH()),
      comment: publicKey?.comment || null,
      permissionsTooOpen
    }
  }

  if (!parsed.isPrivateKey()) throw publicKeyError()
  return {
    encrypted: false,
    algorithm: parsed.type,
    fingerprint: hostKeyFingerprint(parsed.getPublicSSH()),
    comment: parsed.comment || null,
    permissionsTooOpen
  }
}

/**
 * Reads and decrypts a key for login. Returns the raw file for ssh2, which
 * re-parses it with the same passphrase. Throws KEY_PASSPHRASE_REQUIRED when
 * the key is encrypted and no passphrase was given.
 */
export async function loadPrivateKey(path: string, passphrase?: string): Promise<Buffer> {
  const { data } = await readKeyFile(path)
  const parsed = firstKey(utils.parseKey(data, passphrase))

  if (parsed instanceof Error) {
    switch (classifyParseError(parsed.message)) {
      case 'passphrase-required':
        throw new AppError('KEY_PASSPHRASE_REQUIRED', 'This key is protected by a passphrase.')
      case 'passphrase-incorrect':
        throw new AppError('KEY_PASSPHRASE_INCORRECT', 'The passphrase is incorrect for this key.')
      default:
        throw invalidKey(path, data)
    }
  }
  if (!parsed.isPrivateKey()) throw publicKeyError()
  return data
}
