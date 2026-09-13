/**
 * Connecting to a remote server. Secrets (a password or key passphrase) cross
 * IPC only inside a connect call; nothing sent back to the renderer contains one.
 */

export interface PasswordAuth {
  type: 'password'
  password: string
}

export interface PrivateKeyAuth {
  type: 'privateKey'
  /** Read by the main process only; the renderer never sees key contents. */
  privateKeyPath: string
  passphrase?: string
}

export interface ConnectRequest {
  host: string
  port: number
  username: string
  auth: PasswordAuth | PrivateKeyAuth
}

export interface ConnectionInfo {
  /** Identifies this connection; requests for a closed connection are rejected. */
  id: string
  host: string
  port: number
  username: string
  /** Where the server puts the user after login. */
  homePath: string
}

export interface HostKeyInfo {
  /** e.g. ssh-ed25519 */
  algorithm: string
  /** OpenSSH format: SHA256:<base64> */
  fingerprint: string
}

export type ConnectOutcome =
  /** `notice` reports a non-fatal problem, such as a secret that couldn't be saved. */
  | { status: 'connected'; connection: ConnectionInfo; notice?: string }
  /** First connection to this host: the user must confirm the key, then trust it by token. */
  | { status: 'host-key-unknown'; token: string; host: string; port: number; hostKey: HostKeyInfo }
  /** The server's key differs from the one trusted before. The connection was refused. */
  | { status: 'host-key-changed'; host: string; port: number; saved: HostKeyInfo; offered: HostKeyInfo }
  /** A password or passphrase is needed: none is saved, or the one given was rejected. */
  | { status: 'secret-required'; kind: 'password' | 'passphrase'; reason: 'not-saved' | 'rejected' }

/** Pushed to the renderer when a connection ends without the user asking. */
export interface ConnectionClosedEvent {
  connectionId: string
  code: 'CONNECTION_LOST'
  message: string
}
