import { describe, expect, it } from 'vitest'
import { fromConnectError, fromSftpError, sftpStatusOf } from './sftp-errors'

const withProps = (message: string, props: Record<string, unknown>): Error => Object.assign(new Error(message), props)

describe('fromConnectError', () => {
  it.each([
    [withProps('getaddrinfo ENOTFOUND x', { code: 'ENOTFOUND', level: 'client-socket' }), 'HOST_NOT_FOUND'],
    [withProps('getaddrinfo EAI_AGAIN x', { code: 'EAI_AGAIN' }), 'HOST_NOT_FOUND'],
    [withProps('connect ECONNREFUSED', { code: 'ECONNREFUSED', level: 'client-socket' }), 'CONNECTION_REFUSED'],
    [withProps('connect EHOSTUNREACH', { code: 'EHOSTUNREACH' }), 'UNREACHABLE'],
    [withProps('connect ENETUNREACH', { code: 'ENETUNREACH' }), 'UNREACHABLE'],
    [withProps('connect ETIMEDOUT', { code: 'ETIMEDOUT' }), 'CONNECTION_TIMED_OUT'],
    [withProps('read ECONNRESET', { code: 'ECONNRESET' }), 'CONNECTION_LOST'],
    [withProps('Timed out while waiting for handshake', { level: 'client-timeout' }), 'CONNECTION_TIMED_OUT'],
    [withProps('All configured authentication methods failed', { level: 'client-authentication' }), 'AUTH_FAILED'],
    [withProps('Handshake failed: no matching key exchange algorithm', { level: 'handshake' }), 'HANDSHAKE_FAILED'],
    [withProps('Host denied (verification failed)', { level: 'handshake' }), 'HANDSHAKE_FAILED'],
    [new Error('Connection lost before handshake'), 'CONNECTION_LOST']
  ])('maps %s to %s', (error, code) => {
    expect(fromConnectError(error, 'example.com', 2222)?.code).toBe(code)
  })

  it('names the host and port the user typed', () => {
    const refused = fromConnectError(withProps('x', { code: 'ECONNREFUSED' }), 'example.com', 2222)
    expect(refused?.message).toContain('"example.com"')
    expect(refused?.message).toContain('2222')
  })

  it('never passes the raw library message through', () => {
    const raw = withProps('All configured authentication methods failed', { level: 'client-authentication' })
    expect(fromConnectError(raw, 'h', 22)?.message).not.toContain('configured authentication methods')
  })

  it('returns null for unrecognised failures, so they are logged in full', () => {
    expect(fromConnectError(new Error('something odd'), 'h', 22)).toBeNull()
    expect(fromConnectError(withProps('protocol', { level: 'protocol', code: 11 }), 'h', 22)).toBeNull()
    expect(fromConnectError('text', 'h', 22)).toBeNull()
  })
})

describe('SFTP status errors', () => {
  it('reads numeric status codes but not errno strings', () => {
    expect(sftpStatusOf(withProps('No such file', { code: 2 }))).toBe(2)
    expect(sftpStatusOf(withProps('x', { code: 'ENOENT' }))).toBeUndefined()
    expect(sftpStatusOf(null)).toBeUndefined()
  })

  it.each([
    [2, 'NOT_FOUND'],
    [3, 'PERMISSION_DENIED']
  ])('maps status %s to %s', (status, code) => {
    expect(fromSftpError(withProps('x', { code: status }))?.code).toBe(code)
  })

  it('leaves other statuses to be logged', () => {
    expect(fromSftpError(withProps('Failure', { code: 4 }))).toBeNull()
    expect(fromSftpError(withProps('Op unsupported', { code: 8 }))).toBeNull()
  })
})
