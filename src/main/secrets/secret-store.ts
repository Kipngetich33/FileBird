/**
 * Where passwords and passphrases are kept (spec section 9). The app never
 * writes secrets anywhere else, so swapping this implementation is the only
 * change needed to move them.
 */
export interface SecretStore {
  /** Null when nothing is stored. */
  get(account: string): Promise<string | null>
  set(account: string, secret: string): Promise<void>
  /** Idempotent: deleting a missing secret is not an error. */
  delete(account: string): Promise<void>
}

export type SecretKind = 'password' | 'passphrase'

export function secretAccount(connectionId: string, kind: SecretKind): string {
  return `connection/${connectionId}/${kind}`
}

/**
 * Keychain service names. Kept apart so development runs and tests never read
 * or overwrite the released app's secrets, and a signed release never prompts
 * for items the unsigned development build created.
 */
export function keychainService(isPackaged: boolean): string {
  return isPackaged ? 'Fly' : 'Fly (development)'
}
