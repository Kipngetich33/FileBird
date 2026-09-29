import type { FileEntry, FileKind } from '../../shared/types/files'
import type { AppError } from '../errors'

/**
 * The seam between the app and any particular SSH library (spec section 7).
 *
 * Grows with the milestones that need it: connect and list (M3), transfers (M6);
 * delete and mkdir arrive with file operations (M8).
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

/**
 * One interactive shell on a connection (Milestone 11). The connection is
 * shared with file transfers, so closing a shell only ever ends its own channel.
 */
export interface ShellSession {
  /** Keystrokes, as the bytes the terminal produced. */
  write(data: Uint8Array): void
  /** The terminal's new size in characters. */
  resize(cols: number, rows: number): void
  /** Stops and restarts the server's output while the terminal catches up. */
  setFlowing(flowing: boolean): void
  /** Ends this shell. The connection, and any transfer on it, carries on. */
  close(): void
}

export interface ShellHandlers {
  /** Raw output. Never decoded here: a character can straddle two chunks. */
  onData: (chunk: Buffer) => void
  /** The shell ended, whether by exiting, by close(), or with the connection. */
  onClose: (end: { code: number | null; signal: string | null }) => void
}

export interface ShellOptions {
  cols: number
  rows: number
  handlers: ShellHandlers
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

  /** Null when nothing exists at `path`. Follows symlinks. */
  stat(path: string): Promise<RemoteFileStat | null>
  /** Uploads to `remotePath` exactly (the caller picks a temporary name). */
  upload(localPath: string, remotePath: string, options: UploadOptions): Promise<void>
  download(remotePath: string, localPath: string, options: TransferOptions): Promise<void>
  /** Renames, replacing an existing file at `to` (atomically where the server supports it). */
  rename(from: string, to: string): Promise<void>
  /** Removes a file. */
  remove(path: string): Promise<void>
  /** Creates a folder; 'exists' if a folder is already there. A file of that name is ALREADY_EXISTS. */
  mkdir(path: string): Promise<'created' | 'exists'>
  /** Like stat, but describes a symbolic link itself. Null when nothing is there. */
  lstat(path: string): Promise<LinkStat | null>
  /** Renames without ever replacing: an existing `to` is ALREADY_EXISTS. */
  renameNoReplace(from: string, to: string): Promise<void>
  /** Removes an empty folder. */
  removeDirectory(path: string): Promise<void>
  /** Opens an interactive shell with a pseudo-terminal, alongside the file session. */
  openShell(options: ShellOptions): Promise<ShellSession>
}

export interface LinkStat {
  kind: FileKind
  isSymlink: boolean
}

export interface RemoteFileStat {
  kind: FileKind
  size: number
  /** Epoch milliseconds. */
  modifiedAt: number | null
  /** Permission bits only. */
  mode: number | null
}

export interface TransferOptions {
  /** Aborting stops the transfer and rejects with TransferCancelled. */
  signal: AbortSignal
  /** Called for every chunk: throttle before showing it anywhere. */
  onProgress: (transferred: number, total: number) => void
}

export interface UploadOptions extends TransferOptions {
  mode: number
  /** Epoch milliseconds to set as the file's modification time, if known. */
  modifiedAt: number | null
}

/** Thrown by upload/download when their signal was aborted. Not an error to show. */
export class TransferCancelled extends Error {
  constructor() {
    super('Transfer cancelled')
    this.name = 'TransferCancelled'
  }
}
