import { ipcMain, type WebContents } from 'electron'
import type { IpcChannel } from '../../shared/constants/channels'
import { AppError } from '../errors'
import { createLogger } from '../logger'

const log = createLogger('ipc')

/**
 * Wrapper around ipcMain.handle that guarantees the error contract.
 *
 * Any thrown AppError becomes a user-friendly payload. Anything else is logged
 * in full and replaced with a generic message, so internals never leak to the
 * renderer (spec section 17).
 */
export function handle<TResult>(
  channel: IpcChannel,
  handler: (...args: unknown[]) => TResult | Promise<TResult>
): void {
  handleWithSender(channel, (_sender, ...args) => handler(...args))
}

/** Like `handle`, for the few handlers that need the calling page, e.g. to place a menu on its window. */
export function handleWithSender<TResult>(
  channel: IpcChannel,
  handler: (sender: WebContents, ...args: unknown[]) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(event.sender, ...args)
    } catch (error) {
      if (error instanceof AppError) {
        log.warn('Rejected IPC call', { channel, code: error.code })
        throw new Error(JSON.stringify(error.toPayload()))
      }

      log.error('Unhandled IPC failure', {
        channel,
        error: error instanceof Error ? error.stack : String(error)
      })
      throw new Error(
        JSON.stringify({ code: 'INTERNAL', message: 'Something went wrong. Please try again.' })
      )
    }
  })
}
