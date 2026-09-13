import { AsyncEntry } from '@napi-rs/keyring'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import type { SecretStore } from './secret-store'
import { APP_NAME } from '../../shared/constants/app'

const log = createLogger('secrets')

function unavailable(action: string, error: unknown): AppError {
  // The account name is safe to log; the secret itself never reaches this function.
  log.error('Keychain operation failed', { action, error: error instanceof Error ? error.message : String(error) })
  return new AppError('KEYCHAIN_UNAVAILABLE', `${APP_NAME} couldn't use the system keychain. Your password or passphrase wasn't saved.`)
}

/**
 * The operating system's credential store: macOS Keychain, Windows Credential
 * Manager or Linux Secret Service, one item per secret. Uses the async API so
 * the main process is never blocked on a keychain call.
 */
export class KeyringSecretStore implements SecretStore {
  private readonly service: string

  constructor(service: string) {
    this.service = service
  }

  async get(account: string): Promise<string | null> {
    try {
      return (await new AsyncEntry(this.service, account).getPassword()) ?? null
    } catch (error) {
      throw unavailable('get', error)
    }
  }

  async set(account: string, secret: string): Promise<void> {
    try {
      await new AsyncEntry(this.service, account).setPassword(secret)
    } catch (error) {
      throw unavailable('set', error)
    }
  }

  async delete(account: string): Promise<void> {
    try {
      await new AsyncEntry(this.service, account).deletePassword()
    } catch (error) {
      throw unavailable('delete', error)
    }
  }
}
