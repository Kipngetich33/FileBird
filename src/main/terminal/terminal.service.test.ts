import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors'
import type { ShellOptions, ShellSession } from './shell'
import { MAX_SESSIONS_PER_CONNECTION, TerminalService } from './terminal.service'

const CONNECTION = '11111111-1111-4111-8111-111111111111'

/** A shell that records what it was told, and can push output back. */
function fakeShell() {
  const calls = { writes: [] as string[], resizes: [] as Array<[number, number]>, flowing: [] as boolean[], closed: 0 }
  let handlers: ShellOptions['handlers'] | null = null
  const session: ShellSession = {
    write: (data) => calls.writes.push(Buffer.from(data).toString('utf8')),
    resize: (cols, rows) => calls.resizes.push([cols, rows]),
    setFlowing: (flowing) => calls.flowing.push(flowing),
    close: () => {
      calls.closed += 1
    }
  }
  return {
    calls,
    session,
    attach: (options: ShellOptions) => {
      handlers = options.handlers
      return session
    },
    emit: (text: string) => handlers?.onData(Buffer.from(text, 'utf8')),
    end: (code: number | null = 0) => handlers?.onClose({ code, signal: null })
  }
}

function serviceWith(shell: ReturnType<typeof fakeShell>) {
  const data: Array<{ id: string; text: string }> = []
  const exits: Array<{ id: string; code: number | null }> = []
  const service = new TerminalService({
    openRemoteShell: (_connectionId, options) => Promise.resolve(shell.attach(options)),
    openLocal: (options) => shell.attach(options),
    homeDirectory: '/home/me',
    onData: (id, chunk) => data.push({ id, text: chunk.toString('utf8') }),
    onExit: (id, end) => exits.push({ id, code: end.code })
  })
  return { service, data, exits }
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError'
  }
  return 'no error'
}

describe('TerminalService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens a local shell in the folder the pane is showing', async () => {
    const shell = fakeShell()
    const { service } = serviceWith(shell)
    const { id } = await service.open({ side: 'local', connectionId: null, cwd: '/home/me/work', cols: 80, rows: 24 })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(service.count()).toBe(1)
    // A local shell is started in the folder; nothing is typed into it.
    expect(shell.calls.writes).toEqual([])
  })

  it('moves a remote shell to the folder once, and never again', async () => {
    const shell = fakeShell()
    const { service } = serviceWith(shell)
    const { id } = await service.open({ side: 'remote', connectionId: CONNECTION, cwd: "/srv/it's here", cols: 80, rows: 24 })
    expect(shell.calls.writes).toEqual([`cd '/srv/it'\\''s here'\n`])
    service.resize(id, 100, 30)
    expect(shell.calls.writes).toHaveLength(1)
  })

  it('refuses a remote terminal with no connection', async () => {
    const { service } = serviceWith(fakeShell())
    expect(await codeOf(() => service.open({ side: 'remote', connectionId: null, cwd: null, cols: 80, rows: 24 }))).toBe('INVALID_INPUT')
  })

  it('gathers output into one message instead of hundreds', async () => {
    const shell = fakeShell()
    const { service, data } = serviceWith(shell)
    const { id } = await service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 })
    shell.emit('one ')
    shell.emit('two ')
    shell.emit('three')
    expect(data).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(data).toEqual([{ id, text: 'one two three' }])
  })

  it('pauses a shell that outruns the terminal, and starts it again once it catches up', async () => {
    const shell = fakeShell()
    const { service } = serviceWith(shell)
    const { id } = await service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 })
    shell.emit('x'.repeat(100_001))
    expect(shell.calls.flowing).toEqual([false])
    service.acknowledge(id, 50_000)
    expect(shell.calls.flowing).toEqual([false])
    service.acknowledge(id, 50_000)
    expect(shell.calls.flowing).toEqual([false, true])
  })

  it('shows whatever a shell printed before it ended, then reports the end', async () => {
    const shell = fakeShell()
    const { service, data, exits } = serviceWith(shell)
    const { id } = await service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 })
    shell.emit('goodbye')
    shell.end(3)
    expect(data).toEqual([{ id, text: 'goodbye' }])
    expect(exits).toEqual([{ id, code: 3 }])
    expect(service.count()).toBe(0)
    expect(await codeOf(async () => service.write(id, new Uint8Array([1])))).toBe('NOT_FOUND')
  })

  it('closes every terminal on a connection that has gone, and leaves the others alone', async () => {
    const shell = fakeShell()
    const { service, exits } = serviceWith(shell)
    const remote = await service.open({ side: 'remote', connectionId: CONNECTION, cwd: null, cols: 80, rows: 24 })
    const local = await service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 })
    service.closeForConnection(CONNECTION)
    expect(exits.map((exit) => exit.id)).toEqual([remote.id])
    expect(service.count()).toBe(1)
    service.closeAll()
    expect(exits.map((exit) => exit.id)).toEqual([remote.id, local.id])
  })

  it('leaves room on the connection for transfers by capping terminals', async () => {
    const shell = fakeShell()
    const { service } = serviceWith(shell)
    for (let opened = 0; opened < MAX_SESSIONS_PER_CONNECTION; opened += 1) {
      await service.open({ side: 'remote', connectionId: CONNECTION, cwd: null, cols: 80, rows: 24 })
    }
    expect(await codeOf(() => service.open({ side: 'remote', connectionId: CONNECTION, cwd: null, cols: 80, rows: 24 }))).toBe('NOT_ALLOWED')
    // Another server, and this computer, are unaffected.
    expect(await codeOf(() => service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 }))).toBe('no error')
  })

  it('ignores a resize for a terminal that has already ended', async () => {
    const shell = fakeShell()
    const { service } = serviceWith(shell)
    const { id } = await service.open({ side: 'local', connectionId: null, cwd: null, cols: 80, rows: 24 })
    shell.end(0)
    expect(() => service.resize(id, 120, 40)).not.toThrow()
    expect(shell.calls.resizes).toEqual([])
  })
})
