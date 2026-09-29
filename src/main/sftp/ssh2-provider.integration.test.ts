import { createServer, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startSftpServer, type SftpTestServer } from '../../../test/support/sftp-container'
import { AppError } from '../errors'
import { hostKeyFingerprint } from './host-keys'
import type { SftpTimeouts } from './sftp-provider'
import { Ssh2SftpProvider } from './ssh2-provider'

const FAST: Partial<SftpTimeouts> = { readyMs: 10_000, keepaliveIntervalMs: 500, keepaliveCountMax: 2 }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`
  }
  return 'did not throw'
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return address.port
}

function connectTo(
  server: SftpTestServer,
  overrides: { password?: string; verifyHostKey?: (key: Buffer) => boolean; timeouts?: Partial<SftpTimeouts> } = {}
): { provider: Ssh2SftpProvider; connected: Promise<void> } {
  const provider = new Ssh2SftpProvider(overrides.timeouts ?? FAST)
  const connected = provider.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    auth: { type: 'password', password: overrides.password ?? server.password },
    verifyHostKey: overrides.verifyHostKey ?? (() => true)
  })
  return { provider, connected }
}

describe('Ssh2SftpProvider against OpenSSH', () => {
  let server: SftpTestServer

  beforeAll(async () => {
    server = await startSftpServer('provider')
    await server.buildFixture()
  })

  afterAll(async () => {
    await server?.remove()
  })

  it('logs in with a password and starts in the home folder', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    expect(await provider.realpath('.')).toBe('/config')
    await provider.disconnect()
  })

  it('sees the same host key fingerprint OpenSSH reports', async () => {
    let seen = ''
    const { provider, connected } = connectTo(server, {
      verifyHostKey: (key) => {
        seen = hostKeyFingerprint(key)
        return true
      }
    })
    await connected
    await provider.disconnect()
    expect(await server.keyscanFingerprints()).toContain(seen)
  })

  it('lists a folder: kinds, sizes, times, hidden files and symlinks', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    const entries = await provider.list('/config/fixture')
    await provider.disconnect()

    const by = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
    expect(Object.keys(by).sort()).toEqual(
      ['.hidden', 'alpha', 'broken-link', 'file10.txt', 'file2.txt', 'link-to-alpha', 'locked'].sort()
    )
    expect(by['file2.txt']).toMatchObject({ kind: 'file', size: 5, isSymlink: false, path: '/config/fixture/file2.txt' })
    expect(by['alpha']).toMatchObject({ kind: 'directory', size: null, isSymlink: false })
    expect(by['.hidden']?.isHidden).toBe(true)
    expect(by['link-to-alpha']).toMatchObject({ kind: 'directory', isSymlink: true })
    expect(by['broken-link']).toMatchObject({ kind: 'other', isSymlink: true, size: null })

    // SFTP sends seconds; entries carry milliseconds within a sane recent window.
    const modified = by['file2.txt']?.modifiedAt ?? 0
    expect(modified % 1000).toBe(0)
    expect(Math.abs(Date.now() - modified)).toBeLessThan(24 * 60 * 60 * 1000)
  })

  it('reports missing, file-as-folder and unreadable folders distinctly', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    expect(await codeOf(provider.list('/config/fixture/nope'))).toBe('NOT_FOUND')
    expect(await codeOf(provider.list('/config/fixture/file2.txt'))).toBe('NOT_A_DIRECTORY')
    expect(await codeOf(provider.list('/config/fixture/locked'))).toBe('PERMISSION_DENIED')
    await provider.disconnect()
  })

  it('reports a wrong password as AUTH_FAILED', async () => {
    expect(await codeOf(connectTo(server, { password: 'wrong' }).connected)).toBe('AUTH_FAILED')
  })

  it('refuses a server whose host key is rejected', async () => {
    expect(await codeOf(connectTo(server, { verifyHostKey: () => false }).connected)).toBe('HANDSHAKE_FAILED')
  })

  it('reports nothing listening as CONNECTION_REFUSED', async () => {
    const provider = new Ssh2SftpProvider(FAST)
    const port = await closedPort()
    const outcome = provider.connect({ host: '127.0.0.1', port, username: 'x', auth: { type: 'password', password: 'x' }, verifyHostKey: () => true })
    expect(await codeOf(outcome)).toBe('CONNECTION_REFUSED')
  })

  it('reports an unresolvable host as HOST_NOT_FOUND', async () => {
    const provider = new Ssh2SftpProvider(FAST)
    // RFC 6761: .invalid never resolves.
    const outcome = provider.connect({ host: 'fly-test.invalid', port: 22, username: 'x', auth: { type: 'password', password: 'x' }, verifyHostKey: () => true })
    expect(await codeOf(outcome)).toBe('HOST_NOT_FOUND')
  })

  describe('a server that accepts TCP but never speaks SSH', () => {
    let silent: Server
    let port: number

    beforeAll(async () => {
      silent = createServer(() => undefined)
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
      const address = silent.address()
      if (typeof address !== 'object' || address === null) throw new Error('no port')
      port = address.port
    })

    afterAll(async () => {
      silent.close()
    })

    it('times out as CONNECTION_TIMED_OUT', async () => {
      const provider = new Ssh2SftpProvider({ ...FAST, readyMs: 800 })
      const outcome = provider.connect({ host: '127.0.0.1', port, username: 'x', auth: { type: 'password', password: 'x' }, verifyHostKey: () => true })
      expect(await codeOf(outcome)).toBe('CONNECTION_TIMED_OUT')
    })

    it('survives the second error ssh2 emits after a timeout', async () => {
      // ssh2 follows "Timed out while waiting for handshake" with "Connection
      // lost before handshake". An unhandled second 'error' would throw here
      // and fail this file with an unhandled error.
      const provider = new Ssh2SftpProvider({ ...FAST, readyMs: 800 })
      const outcome = provider.connect({ host: '127.0.0.1', port, username: 'x', auth: { type: 'password', password: 'x' }, verifyHostKey: () => true })
      await codeOf(outcome)
      silent.close()
      await sleep(1_500)
      expect(true).toBe(true)
    })
  })

  it('disconnects cleanly: idempotent, no close event, later requests NOT_CONNECTED', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    let closeEvents = 0
    provider.onUnexpectedClose(() => closeEvents++)
    await provider.disconnect()
    await provider.disconnect()
    expect(await codeOf(provider.list('/config'))).toBe('NOT_CONNECTED')
    await sleep(300)
    expect(closeEvents).toBe(0)
  })

  it('notices a server-side session kill promptly', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    const started = Date.now()
    const lost = new Promise<string>((resolve) => provider.onUnexpectedClose((error) => resolve(error.code)))
    await server.killSessions()
    expect(await lost).toBe('CONNECTION_LOST')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await codeOf(provider.list('/config'))).toBe('NOT_CONNECTED')
  })

  it('notices a silent network loss through keepalives', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    const started = Date.now()
    const lost = new Promise<string>((resolve) => provider.onUnexpectedClose((error) => resolve(error.code)))
    await server.pause()
    try {
      expect(await lost).toBe('CONNECTION_LOST')
      // 500 ms interval × 2 missed replies, plus scheduling slack.
      expect(Date.now() - started).toBeLessThan(6_000)
    } finally {
      await server.unpause()
    }
  })
  describe('an interactive shell on the same connection', () => {
    /** Collects a shell's output, so a test can wait for what a command printed. */
    function harness() {
      const chunks: Buffer[] = []
      const ends: Array<{ code: number | null; signal: string | null }> = []
      return {
        ends,
        text: (): string => Buffer.concat(chunks).toString('utf8'),
        handlers: {
          onData: (chunk: Buffer) => chunks.push(chunk),
          onClose: (end: { code: number | null; signal: string | null }) => ends.push(end)
        },
        async waitFor(needle: string, ms = 15_000): Promise<boolean> {
          const deadline = Date.now() + ms
          while (Date.now() < deadline) {
            if (Buffer.concat(chunks).toString('utf8').includes(needle)) return true
            await sleep(100)
          }
          return false
        }
      }
    }

    const type = (shell: { write: (data: Uint8Array) => void }, line: string): void => {
      shell.write(new Uint8Array(Buffer.from(`${line}\n`, 'utf8')))
    }

    it('runs a command in a real terminal and reports how it ended', async () => {
      const { provider, connected } = connectTo(server)
      await connected
      const out = harness()
      const shell = await provider.openShell({ cols: 80, rows: 24, handlers: out.handlers })

      type(shell, 'echo FLY-SHELL-$((6*7))')
      expect(await out.waitFor('FLY-SHELL-42')).toBe(true)
      // A pty, not a plain command channel: this is what `sudo`, `top` and `vim` need.
      type(shell, 'tty; echo TERM-IS-$TERM')
      expect(await out.waitFor('TERM-IS-xterm-256color')).toBe(true)
      expect(out.text()).toMatch(/\/dev\/pts\/\d+/)

      type(shell, 'exit 7')
      await out.waitFor('__never__', 3_000)
      expect(out.ends).toEqual([{ code: 7, signal: null }])
      await provider.disconnect()
    })

    it('tells the shell its size, first and after a resize', async () => {
      const { provider, connected } = connectTo(server)
      await connected
      const out = harness()
      const shell = await provider.openShell({ cols: 100, rows: 30, handlers: out.handlers })

      type(shell, 'stty size')
      expect(await out.waitFor('30 100')).toBe(true)
      shell.resize(120, 40)
      await sleep(300)
      type(shell, 'stty size')
      expect(await out.waitFor('40 120')).toBe(true)

      shell.close()
      await provider.disconnect()
    })

    it('leaves the connection working when a shell closes, and opens another afterwards', async () => {
      const { provider, connected } = connectTo(server)
      await connected
      const first = harness()
      const shell = await provider.openShell({ cols: 80, rows: 24, handlers: first.handlers })
      type(shell, 'echo FIRST-SHELL')
      expect(await first.waitFor('FIRST-SHELL')).toBe(true)

      shell.close()
      await sleep(500)
      expect(first.ends).toHaveLength(1)

      // Browsing still works: closing a terminal must never end the connection.
      expect((await provider.list('/config/fixture')).length).toBeGreaterThan(0)

      const second = harness()
      const another = await provider.openShell({ cols: 80, rows: 24, handlers: second.handlers })
      type(another, 'echo SECOND-SHELL')
      expect(await second.waitFor('SECOND-SHELL')).toBe(true)
      another.close()
      await provider.disconnect()
    })

    it('ends every shell when the connection goes', async () => {
      const { provider, connected } = connectTo(server)
      await connected
      const out = harness()
      await provider.openShell({ cols: 80, rows: 24, handlers: out.handlers })
      await provider.disconnect()
      await sleep(500)
      expect(out.ends).toHaveLength(1)
    })

    it('refuses a shell when nothing is connected', async () => {
      const provider = new Ssh2SftpProvider(FAST)
      expect(await codeOf(provider.openShell({ cols: 80, rows: 24, handlers: harness().handlers }))).toBe('NOT_CONNECTED')
    })
  })

})

describe('Ssh2SftpProvider against a reconfigured OpenSSH', () => {
  let server: SftpTestServer

  beforeAll(async () => {
    server = await startSftpServer('variant')
    // Passwords only through keyboard-interactive (PAM), as many servers do.
    await server.configureSshd(['UsePAM yes', 'PasswordAuthentication no'])
  })

  afterAll(async () => {
    await server?.remove()
  })

  it('logs in through keyboard-interactive when password auth is off', async () => {
    const { provider, connected } = connectTo(server)
    await connected
    expect(await provider.realpath('.')).toBe('/config')
    await provider.disconnect()
  })

  it('does not hang or retry the password when keyboard-interactive rejects it', async () => {
    const started = Date.now()
    expect(await codeOf(connectTo(server, { password: 'wrong' }).connected)).toBe('AUTH_FAILED')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('reports no common key exchange as HANDSHAKE_FAILED', async () => {
    // ssh2 1.17 has no post-quantum key exchange.
    await server.configureSshd(['KexAlgorithms mlkem768x25519-sha256'])
    expect(await codeOf(connectTo(server).connected)).toBe('HANDSHAKE_FAILED')
  })
})
