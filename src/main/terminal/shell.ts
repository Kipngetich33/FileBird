/**
 * One interactive shell, wherever it runs (Milestone 11).
 *
 * A remote shell is a channel on a live SSH connection; a local one is a
 * pseudo-terminal on this computer. Both look the same from here, so the
 * service that owns sessions doesn't care which it is holding.
 */
export interface ShellSession {
  /** Keystrokes, as the bytes the terminal produced. */
  write(data: Uint8Array): void
  /** The terminal's new size in characters. */
  resize(cols: number, rows: number): void
  /** Stops and restarts the flow of output while the terminal catches up. */
  setFlowing(flowing: boolean): void
  /** Ends this shell, and nothing else around it. */
  close(): void
}

export interface ShellHandlers {
  /** Raw output. Never decoded here: one character can straddle two chunks. */
  onData: (chunk: Buffer) => void
  /** The shell ended, whether by exiting, by close(), or with its connection. */
  onClose: (end: { code: number | null; signal: string | null }) => void
}

export interface ShellOptions {
  cols: number
  rows: number
  handlers: ShellHandlers
}

/**
 * A path as a single shell word: everything inside single quotes is literal,
 * and a single quote itself is closed, escaped and reopened.
 */
export function quoteForShell(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}
