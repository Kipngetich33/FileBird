import { AppError } from '../errors'
import { createLogger } from '../logger'
import type { ShellOptions, ShellSession } from './shell'

const log = createLogger('terminal')

/** What $TERM says inside a shell: xterm.js speaks this, and servers have had it for years. */
export const TERM_NAME = 'xterm-256color'

/**
 * Variables that must not reach a shell the user types in.
 *
 * Electron's own switches would make a child Electron behave strangely (the
 * ELECTRON_RUN_AS_NODE trap), and the app's development overrides describe
 * Fly's test setup, not the user's computer.
 */
const DROPPED_ENV = /^(ELECTRON_|NODE_OPTIONS$|FLY_DEV_)/

export function shellEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !DROPPED_ENV.test(name)) env[name] = value
  }
  env['TERM'] = TERM_NAME
  return env
}

/** The user's own shell where the system names one, else the platform's usual. */
export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env['COMSPEC'] ?? 'powershell.exe', args: [] }
  const file = env['SHELL'] ?? '/bin/bash'
  // macOS expects a login shell: that is where PATH and the rest of the setup comes from.
  return { file, args: platform === 'darwin' ? ['-l'] : [] }
}

export interface LocalShellOptions extends ShellOptions {
  /** The folder to start in; the home folder when it can't be used. */
  cwd: string
  home: string
}

interface PtyModule {
  spawn: (
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ) => {
    onData: (listener: (data: string) => void) => void
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    pause: () => void
    resume: () => void
    kill: (signal?: string) => void
  }
}

let ptyModule: PtyModule | null = null

/**
 * node-pty carries a prebuilt binary per platform, so nothing is compiled here
 * (Milestone 10 plan D1 still holds). It is loaded on first use and inside a
 * try/catch: if the binary is missing or won't load, only the terminal is
 * unavailable, and the file manager carries on.
 */
function loadPty(): PtyModule {
  if (ptyModule !== null) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a native module, loaded only if a terminal is opened
    ptyModule = require('node-pty') as PtyModule
    return ptyModule
  } catch (error) {
    log.error('The local terminal is unavailable', { message: error instanceof Error ? error.message : String(error) })
    throw new AppError('TERMINAL_UNAVAILABLE', "This build can't open a local terminal on this computer. The remote terminal still works.")
  }
}

/** A shell on this computer, in a real pseudo-terminal so full-screen programs work. */
export function openLocalShell(options: LocalShellOptions): ShellSession {
  const pty = loadPty()
  const { file, args } = defaultShell(process.platform, process.env)
  const spawn = (cwd: string): ReturnType<PtyModule['spawn']> =>
    pty.spawn(file, args, {
      name: TERM_NAME,
      cols: options.cols,
      rows: options.rows,
      cwd,
      env: shellEnvironment(process.env)
    })

  let child: ReturnType<PtyModule['spawn']>
  try {
    child = spawn(options.cwd)
  } catch (error) {
    // A folder that has since been removed or is unreadable must not lose the terminal.
    log.warn('Starting the shell in the pane folder failed; using the home folder', {
      message: error instanceof Error ? error.message : String(error)
    })
    try {
      child = spawn(options.home)
    } catch (homeError) {
      throw new AppError('TERMINAL_UNAVAILABLE', homeError instanceof Error ? homeError.message : 'The shell could not be started.')
    }
  }

  let ended = false
  // node-pty hands over text; the bytes are what the terminal is written with,
  // and a character split across two reads is already whole by this point.
  child.onData((data) => options.handlers.onData(Buffer.from(data, 'utf8')))
  child.onExit(({ exitCode, signal }) => {
    ended = true
    options.handlers.onClose({ code: exitCode, signal: signal === undefined ? null : String(signal) })
  })

  return {
    write: (data) => {
      if (!ended) child.write(Buffer.from(data).toString('utf8'))
    },
    resize: (cols, rows) => {
      if (!ended) child.resize(cols, rows)
    },
    setFlowing: (flowing) => {
      if (ended) return
      if (flowing) child.resume()
      else child.pause()
    },
    close: () => {
      if (!ended) child.kill()
    }
  }
}
