import { isAppErrorPayload, type AppErrorPayload } from '@shared/types/errors'

const FALLBACK: AppErrorPayload = {
  code: 'INTERNAL',
  message: 'Something went wrong. Please try again.'
}

/**
 * Electron wraps a rejected `invoke` as:
 *   "Error invoking remote method 'x': Error: {json}"
 *
 * The main process encodes its user-facing payload as that JSON, so we dig it
 * back out here. Anything unparseable becomes a generic message rather than
 * leaking raw internals into the UI (spec section 17).
 */
export function toAppError(error: unknown): AppErrorPayload {
  const raw = error instanceof Error ? error.message : String(error)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return FALLBACK

  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    return isAppErrorPayload(parsed) ? parsed : FALLBACK
  } catch {
    return FALLBACK
  }
}
