import { AppError, errnoOf } from '../errors'
import { APP_NAME } from '../../shared/constants/app'

/** SFTP status codes (draft-ietf-secsh-filexfer-02) that the user can act on. */
export const SFTP_STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3
} as const

/** ssh2 puts the SFTP status on `code` as a number (errno strings are system errors). */
export function sftpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'number' ? error.code : undefined
}

function levelOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('level' in error)) return undefined
  return typeof error.level === 'string' ? error.level : undefined
}

export function fromSftpError(error: unknown): AppError | null {
  switch (sftpStatusOf(error)) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return new AppError(
        'NOT_FOUND',
        "This folder doesn't exist on the server. It may have been moved or deleted."
      )
    case SFTP_STATUS.PERMISSION_DENIED:
      return new AppError('PERMISSION_DENIED', "You don't have permission to open this folder on the server.")
    default:
      return null
  }
}

export const notADirectory = (): AppError => new AppError('NOT_A_DIRECTORY', 'This is a file, not a folder.')

export const connectionLost = (): AppError =>
  new AppError('CONNECTION_LOST', 'Network connection lost. The server stopped responding.')

export const notConnected = (): AppError =>
  new AppError('NOT_CONNECTED', 'This connection has closed. Connect again to continue.')

/**
 * Maps a failure while connecting (before the session is ready) to a message
 * about what the user can check. Returns null for anything unrecognised, which
 * callers rethrow so it is logged in full.
 */
export function fromConnectError(
  error: unknown,
  host: string,
  port: number,
  authType: 'password' | 'privateKey' = 'password'
): AppError | null {
  switch (errnoOf(error)) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return new AppError('HOST_NOT_FOUND', `Couldn't find a server called "${host}". Check the host name.`)
    case 'ECONNREFUSED':
      return new AppError('CONNECTION_REFUSED', `"${host}" isn't accepting connections on port ${port}.`)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new AppError('UNREACHABLE', `Can't reach "${host}". Check your network connection.`)
    case 'ETIMEDOUT':
      return new AppError('CONNECTION_TIMED_OUT', `Connection to "${host}" timed out.`)
    case 'ECONNRESET':
    case 'EPIPE':
      return new AppError('CONNECTION_LOST', `"${host}" closed the connection while it was being set up.`)
  }

  switch (levelOf(error)) {
    case 'client-timeout':
      return new AppError('CONNECTION_TIMED_OUT', `Connection to "${host}" timed out.`)
    case 'client-authentication':
      return authType === 'privateKey'
        ? new AppError(
            'AUTH_FAILED',
            "The server didn't accept this key. Check the username, and that the key's public half is authorised on the server."
          )
        : new AppError('AUTH_FAILED', 'Authentication failed. Check the username and password.')
    case 'handshake':
      return new AppError(
        'HANDSHAKE_FAILED',
        `Couldn't agree on a secure connection with "${host}". The server may require encryption ${APP_NAME} doesn't support.`
      )
  }

  if (error instanceof Error && error.message === 'Connection lost before handshake') {
    return new AppError('CONNECTION_LOST', `"${host}" closed the connection while it was being set up.`)
  }
  return null
}
