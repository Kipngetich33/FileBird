import { randomUUID } from 'node:crypto'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import { FlowControl } from './flow-control'
import { openLocalShell } from './local-shell'
import { quoteForShell, type ShellOptions, type ShellSession } from './shell'

const log = createLogger('terminal')

/**
 * Output is gathered for a few milliseconds before it is sent on, so a command
 * that prints thousands of small chunks doesn't become thousands of messages.
 */
const BATCH_MS = 5

/**
 * Terminals share a connection with file transfers, and a server allows only so
 * many channels on one connection (OpenSSH: ten, of which browsing and
 * transfers already use up to four). The UI opens one terminal per pane; these
 * caps are the backstop.
 */
export const MAX_SESSIONS = 8
export const MAX_SESSIONS_PER_CONNECTION = 3

export interface TerminalOpenRequest {
  side: 'local' | 'remote'
  /** The live connection, for the remote side only. */
  connectionId: string | null
  /** The folder to start in; null starts wherever the shell does. */
  cwd: string | null
  cols: number
  rows: number
}

export interface TerminalServiceOptions {
  /** Opens a shell on a live connection; throws when it isn't connected. */
  openRemoteShell: (connectionId: string, options: ShellOptions) => Promise<ShellSession>
  /** Local shells: separated for tests, which must not spawn a real one. */
  openLocal?: (options: ShellOptions & { cwd: string; home: string }) => ShellSession
  /** Where a local shell starts when the pane has no folder. */
  homeDirectory: string
  onData: (id: string, data: Buffer) => void
  onExit: (id: string, end: { code: number | null; signal: string | null }) => void
}

interface Session {
  id: string
  connectionId: string | null
  shell: ShellSession
  flow: FlowControl
  pending: Buffer[]
  timer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

/**
 * Owns every terminal session (Milestone 11 plan D8), as the connection service
 * owns connections: the renderer only ever holds an opaque session id.
 *
 * Nothing here logs what a terminal carries. Terminal output routinely contains
 * passwords, keys and whole environments.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly options: TerminalServiceOptions) {}

  async open(request: TerminalOpenRequest): Promise<{ id: string }> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new AppError('NOT_ALLOWED', `Close a terminal first: ${MAX_SESSIONS} are already open.`)
    }
    const connectionId = request.side === 'remote' ? request.connectionId : null
    if (request.side === 'remote' && connectionId === null) throw new AppError('INVALID_INPUT', 'A remote terminal needs a connection.')
    if (connectionId !== null && this.countFor(connectionId) >= MAX_SESSIONS_PER_CONNECTION) {
      throw new AppError('NOT_ALLOWED', `Close a terminal first: ${MAX_SESSIONS_PER_CONNECTION} are already open on this server.`)
    }

    const id = randomUUID()
    const session: Session = {
      id,
      connectionId,
      shell: null as unknown as ShellSession,
      flow: new FlowControl(),
      pending: [],
      timer: null,
      closed: false
    }
    const handlers = {
      onData: (chunk: Buffer) => this.queue(session, chunk),
      onClose: (end: { code: number | null; signal: string | null }) => this.finish(session, end)
    }
    const shellOptions: ShellOptions = { cols: request.cols, rows: request.rows, handlers }

    session.shell =
      connectionId === null
        ? (this.options.openLocal ?? openLocalShell)({
            ...shellOptions,
            cwd: request.cwd ?? this.options.homeDirectory,
            home: this.options.homeDirectory
          })
        : await this.options.openRemoteShell(connectionId, shellOptions)

    this.sessions.set(id, session)
    log.info('Terminal opened', { side: request.side, sessions: this.sessions.size })

    // The session starts in the folder the pane is showing. This is the only
    // thing ever typed into a shell on the user's behalf: syncing a running
    // shell to the file list interrupts commands and mangles half-typed ones.
    if (connectionId !== null && request.cwd !== null) {
      session.shell.write(Buffer.from(`cd ${quoteForShell(request.cwd)}\n`, 'utf8'))
    }
    return { id }
  }

  write(id: string, data: Uint8Array): void {
    this.require(id).shell.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    // A resize can arrive as a session is ending; that is ordinary, not an error.
    if (session === undefined || session.closed) return
    session.shell.resize(cols, rows)
  }

  /** The terminal reports what it has drawn, which is what lets output start flowing again. */
  acknowledge(id: string, chars: number): void {
    const session = this.sessions.get(id)
    if (session === undefined || session.closed) return
    if (session.flow.acknowledged(chars)) session.shell.setFlowing(true)
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined) return
    session.shell.close()
    this.finish(session, { code: null, signal: null })
  }

  /** Every terminal on a connection that has gone away, disconnected or lost. */
  closeForConnection(connectionId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.connectionId === connectionId) this.close(session.id)
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  count(): number {
    return this.sessions.size
  }

  private countFor(connectionId: string): number {
    let count = 0
    for (const session of this.sessions.values()) if (session.connectionId === connectionId) count += 1
    return count
  }

  private require(id: string): Session {
    const session = this.sessions.get(id)
    if (session === undefined || session.closed) throw new AppError('NOT_FOUND', 'That terminal is closed.')
    return session
  }

  private queue(session: Session, chunk: Buffer): void {
    if (session.closed) return
    session.pending.push(chunk)
    if (session.flow.sent(chunk.length)) session.shell.setFlowing(false)
    if (session.timer !== null) return
    session.timer = setTimeout(() => this.flush(session), BATCH_MS)
  }

  private flush(session: Session): void {
    if (session.timer !== null) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (session.pending.length === 0) return
    const chunk = session.pending.length === 1 ? (session.pending[0] as Buffer) : Buffer.concat(session.pending)
    session.pending = []
    this.options.onData(session.id, chunk)
  }

  private finish(session: Session, end: { code: number | null; signal: string | null }): void {
    if (session.closed) return
    session.closed = true
    // Whatever the shell managed to print before it ended is still worth showing.
    this.flush(session)
    this.sessions.delete(session.id)
    log.info('Terminal closed', { sessions: this.sessions.size })
    this.options.onExit(session.id, end)
  }
}
