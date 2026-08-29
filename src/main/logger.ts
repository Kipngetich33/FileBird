/**
 * Minimal structured logger (spec section 18).
 *
 * Two rules it exists to enforce from day one:
 *   1. Developer logs are separate from anything shown to a user.
 *   2. Credentials never reach the log, even by accident.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

/** Keys whose values are scrubbed before anything is written. */
const SENSITIVE_KEYS = /^(password|passphrase|privatekey|secret|token|credential)/i

const minLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug'

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1)
  }
  return out
}

function write(level: LogLevel, scope: string, message: string, context?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context === undefined ? {} : { context: redact(context) })
  }

  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export interface Logger {
  debug(message: string, context?: unknown): void
  info(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, context) => write('debug', scope, message, context),
    info: (message, context) => write('info', scope, message, context),
    warn: (message, context) => write('warn', scope, message, context),
    error: (message, context) => write('error', scope, message, context)
  }
}

export const logger = createLogger('app')
