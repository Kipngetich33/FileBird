import type { TerminalDataEvent, TerminalExitEvent, TerminalOpenInput } from '@shared/types/terminal'
import { toAppError } from './errors'

async function call<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke()
  } catch (error) {
    throw toAppError(error)
  }
}

/** Terminal sessions (Milestone 11). The renderer only ever holds a session id. */
export const terminalsService = {
  open: (input: TerminalOpenInput): Promise<string> => call(async () => (await window.api.terminals.open(input)).id),
  write: (id: string, data: Uint8Array): Promise<void> => call(() => window.api.terminals.write(id, data)),
  resize: (id: string, cols: number, rows: number): Promise<void> => call(() => window.api.terminals.resize(id, cols, rows)),
  /** How much output has been drawn; a paused shell continues once it catches up. */
  acknowledge: (id: string, chars: number): Promise<void> => window.api.terminals.acknowledge(id, chars).catch(() => undefined),
  close: (id: string): Promise<void> => window.api.terminals.close(id).catch(() => undefined),
  /** Lets the menu hand its keys to a focused terminal. */
  setFocus: (focused: boolean): Promise<void> => window.api.terminals.setFocus(focused).catch(() => undefined),
  /** Returns an unsubscribe function. */
  onData: (listener: (event: TerminalDataEvent) => void): (() => void) => window.api.terminals.onData(listener),
  /** Returns an unsubscribe function. */
  onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => window.api.terminals.onExit(listener)
}
