import { app, shell, session, type BrowserWindow } from 'electron'
import { URL } from 'node:url'
import { createLogger } from './logger'
import { isAllowedNavigation, type NavigationAllowance } from './navigation'

const log = createLogger('security')

/**
 * Content-Security-Policy for the packaged app.
 *
 * Applied only in production: the Vite dev server needs inline styles and a
 * websocket for HMR, and locking those down would break `npm run dev` without
 * making the shipped app any safer.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function applyContentSecurityPolicy(): void {
  if (!app.isPackaged) return

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [PRODUCTION_CSP]
      }
    })
  })
}

/**
 * The renderer only ever loads our own UI.
 *
 * In-app navigation anywhere else is blocked (including other local files), and
 * `target="_blank"` or `window.open` is handed to the user's real browser
 * instead of opening an Electron window with our preload attached.
 */
export function guardNavigation(window: BrowserWindow, allowance: NavigationAllowance): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    else log.warn('Blocked window.open', { url })
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, allowance)) return

    event.preventDefault()
    log.warn('Blocked in-app navigation', { url })
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log.warn('Blocked webview attachment')
  })
}

function isSafeExternalUrl(url: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
