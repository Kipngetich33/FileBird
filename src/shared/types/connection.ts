/**
 * Connecting to a remote server. The password crosses IPC once, inside a
 * ConnectRequest; nothing sent back to the renderer ever contains it.
 */

export interface PasswordAuth {
  type: 'password'
  password: string
}

export interface ConnectRequest {
  host: string
  port: number
  username: string
  auth: PasswordAuth
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
  | { status: 'connected'; connection: ConnectionInfo }
  /** First connection to this host: the user must confirm the key, then trust it by token. */
  | { status: 'host-key-unknown'; token: string; host: string; port: number; hostKey: HostKeyInfo }
  /** The server's key differs from the one trusted before. The connection was refused. */
  | { status: 'host-key-changed'; host: string; port: number; saved: HostKeyInfo; offered: HostKeyInfo }

/** Pushed to the renderer when a connection ends without the user asking. */
export interface ConnectionClosedEvent {
  connectionId: string
  code: 'CONNECTION_LOST'
  message: string
}
