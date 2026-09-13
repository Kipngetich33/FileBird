import type { FileEntry } from '../../shared/types/files'
import type { AppError } from '../errors'

/**
 * The seam between the app and any particular SSH library (spec section 7).
 *
 * Milestone 3 subset. Upload, download, delete, mkdir and rename are added in
 * the milestones that need them rather than stubbed here.
 */
export type SftpAuth =
  | { type: 'password'; password: string }
  /** `key` is the private key file's contents, already checked by loadPrivateKey. */
  | { type: 'privateKey'; key: Buffer; passphrase?: string }

export interface SftpConnectOptions {
  host: string
  port: number
  username: string
  auth: SftpAuth
  /**
   * Called during the handshake with the server's raw public key. Return false
   * to refuse the server; connect() then rejects.
   */
  verifyHostKey: (key: Buffer) => boolean
}

export interface SftpTimeouts {
  /** Whole handshake, including authentication. */
  readyMs: number
  keepaliveIntervalMs: number
  /** Unanswered keepalives before the connection is declared lost. */
  keepaliveCountMax: number
}

export interface SftpProvider {
  /** Resolves once authenticated with an SFTP session open. Rejects with an AppError where the cause is known. */
  connect(options: SftpConnectOptions): Promise<void>
  realpath(path: string): Promise<string>
  /** `path` must be absolute and normalised. */
  list(path: string): Promise<FileEntry[]>
  /** Idempotent. Never reported as an unexpected close. */
  disconnect(): Promise<void>
  /** Fires at most once, when the connection ends without disconnect() being called. */
  onUnexpectedClose(listener: (error: AppError) => void): void
}
