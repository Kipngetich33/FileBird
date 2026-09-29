import { IPC } from '../../shared/constants/channels'
import type { TerminalOpened } from '../../shared/types/terminal'
import { AppError } from '../errors'
import type { TerminalService } from '../terminal/terminal.service'
import { handle } from './handle'
import { assertAbsolutePath, assertBoolean, assertObject, assertRemotePath, assertUuid } from './validate'

/** A terminal no larger than any real window, and never zero. */
const MAX_COLUMNS = 1_000
const MAX_ROWS = 1_000
/** A single keystroke is one byte; a paste can be large, but not unbounded. */
const MAX_WRITE_BYTES = 1024 * 1024

function assertSize(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('INVALID_INPUT', `"${field}" must be a whole number between 1 and ${max}.`)
  }
  return value
}

function assertCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError('INVALID_INPUT', `"${field}" must be a whole number.`)
  }
  return value
}

function assertBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new AppError('INVALID_INPUT', `Expected "${field}" to be bytes.`)
  if (value.byteLength > MAX_WRITE_BYTES) throw new AppError('INVALID_INPUT', `"${field}" is too large.`)
  return value
}

/**
 * Terminal sessions. Every argument is rebuilt field by field: the renderer is
 * untrusted, and a session id is only ever a key into the service's own map.
 */
export function registerTerminalIpc(terminals: TerminalService, options: { setTerminalFocus: (focused: boolean) => void }): void {
  handle<TerminalOpened>(IPC.TERMINAL_OPEN, (raw) => {
    const input = assertObject(raw, 'request')
    const side = input['side']
    if (side !== 'local' && side !== 'remote') throw new AppError('INVALID_INPUT', 'Unknown terminal side.')
    const cwd = input['cwd']
    return terminals.open({
      side,
      connectionId: side === 'remote' ? assertUuid(input['connectionId'], 'connectionId') : null,
      cwd: cwd === undefined ? null : side === 'remote' ? assertRemotePath(cwd, 'cwd') : assertAbsolutePath(cwd, 'cwd'),
      cols: assertSize(input['cols'], 'cols', MAX_COLUMNS),
      rows: assertSize(input['rows'], 'rows', MAX_ROWS)
    })
  })

  handle<void>(IPC.TERMINAL_WRITE, (id, data) => {
    terminals.write(assertUuid(id, 'id'), assertBytes(data, 'data'))
  })

  handle<void>(IPC.TERMINAL_RESIZE, (id, cols, rows) => {
    terminals.resize(assertUuid(id, 'id'), assertSize(cols, 'cols', MAX_COLUMNS), assertSize(rows, 'rows', MAX_ROWS))
  })

  handle<void>(IPC.TERMINAL_ACK, (id, chars) => {
    terminals.acknowledge(assertUuid(id, 'id'), assertCount(chars, 'chars'))
  })

  handle<void>(IPC.TERMINAL_CLOSE, (id) => {
    terminals.close(assertUuid(id, 'id'))
  })

  /**
   * While a terminal has focus, the menu's file commands are disabled, so their
   * keys reach the shell instead of acting on files the user can't even see
   * (Milestone 11 plan D6).
   */
  handle<void>(IPC.TERMINAL_SET_FOCUS, (focused) => {
    options.setTerminalFocus(assertBoolean(focused, 'focused'))
  })
}
