/**
 * Saved connections (spec section 8). Profiles hold metadata only; passwords
 * and passphrases live in the OS keychain and never reach the renderer.
 */

export type ProfileAuth = { type: 'password' } | { type: 'privateKey'; privateKeyPath: string }

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: ProfileAuth
  importedFrom?: { kind: 'ssh-config'; alias: string }
  createdAt: string
  updatedAt: string
}

/** What the renderer sends to create, update or connect without saving. */
export interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string
  auth: ProfileAuth
}

/** A profile as the renderer sees it: whether a secret is saved, never the secret. */
export interface ConnectionSummary extends ConnectionProfile {
  savedSecret: 'password' | 'passphrase' | null
}

/** A secret typed by the user for one connect attempt. */
export interface SecretEntry {
  value: string
  /** Save to the keychain once the server accepts it (ignored for unsaved connections). */
  remember: boolean
}

/** What the connection form shows about a chosen key file. */
export interface KeyInfo {
  encrypted: boolean
  /** Null when the key is encrypted and there is no readable .pub beside it. */
  algorithm: string | null
  fingerprint: string | null
  comment: string | null
  /** Readable by group or others; OpenSSH itself would refuse this key. */
  permissionsTooOpen: boolean
}

export interface ImportCandidate {
  alias: string
  host: string
  port: number
  username: string
  privateKeyPath: string | null
  /** Where the key came from: an IdentityFile line, or OpenSSH's default key names. */
  keySource: 'configured' | 'default' | null
  warnings: string[]
  alreadyImported: boolean
}

export type ImportPreview =
  | { status: 'no-config'; configPath: string }
  /** The config runs commands while being read (Match exec); nothing ran yet. */
  | { status: 'needs-consent'; configPath: string; commands: number }
  | { status: 'ready'; configPath: string; candidates: ImportCandidate[] }
