/**
 * Terminals (Milestone 11). The renderer holds an opaque session id and sends
 * bytes to it; it never sends a command, because the bytes go into a shell that
 * is already running.
 */
export interface TerminalOpenInput {
  side: 'local' | 'remote'
  /** The live connection, for a remote terminal. */
  connectionId?: string
  /** The folder the session should start in. */
  cwd?: string
  cols: number
  rows: number
}

export interface TerminalOpened {
  id: string
}

export interface TerminalDataEvent {
  id: string
  /** Raw output: decoding belongs to the terminal, which keeps its state between chunks. */
  data: Uint8Array
}

export interface TerminalExitEvent {
  id: string
  code: number | null
  signal: string | null
}
