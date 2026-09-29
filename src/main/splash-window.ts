import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { splashWait } from './app-lifecycle'
import { createLogger } from './logger'
import { guardNavigation } from './security'

const log = createLogger('splash')

const FADE_STEPS = 10
const FADE_STEP_MS = 22

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface Splash {
  /** Waits out the start screen's time, fades it away, then shows the main window. */
  handOff(main: BrowserWindow): Promise<void>
}

/**
 * The FileBird start screen: a borderless, transparent window in the middle of
 * the screen, shown while the main window loads out of sight. It has no
 * preload, so its page can do nothing but draw.
 */
export function openSplash(options: { rendererUrl: string | undefined; durationMs: number }): Splash {
  const window = new BrowserWindow({
    width: 820,
    height: 520,
    show: false,
    center: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Above other apps' windows even when Fly isn't the active app yet, as it
    // isn't when launched from a terminal.
    alwaysOnTop: true,
    title: 'FileBird',
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      // Keep animating even if something covers part of the screen.
      backgroundThrottling: false
    }
  })

  // Show over whatever the person is looking at: another app's windows, and
  // any Space, including a full-screen app (a new window would otherwise open
  // on the desktop Space, out of sight, until the main window took focus).
  // Floating over full-screen apps makes macOS treat Fly as an accessory app,
  // with no Dock icon or menu bar, until handOff brings them back.
  window.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  let shownAt: number | null = null
  let unavailable = false
  window.once('ready-to-show', () => {
    shownAt = Date.now()
    window.show()
  })
  window.webContents.once('did-fail-load', (_event, code, description) => {
    unavailable = true
    log.warn('The start screen failed to load', { code, description })
  })
  window.once('closed', () => {
    unavailable = true
  })

  const query = { duration: String(options.durationMs) }
  if (options.rendererUrl !== undefined) {
    const url = new URL('splash.html', options.rendererUrl.endsWith('/') ? options.rendererUrl : `${options.rendererUrl}/`)
    url.search = new URLSearchParams(query).toString()
    guardNavigation(window, { origin: url.origin })
    void window.loadURL(url.href)
  } else {
    const file = join(__dirname, '../renderer/splash.html')
    guardNavigation(window, { exactUrl: pathToFileURL(file).href })
    void window.loadFile(file, { query })
  }

  return {
    async handOff(main) {
      if (!unavailable) await sleep(splashWait({ shownAt, now: Date.now(), durationMs: options.durationMs }))
      if (!window.isDestroyed()) {
        for (let step = FADE_STEPS - 1; step >= 0; step--) {
          window.setOpacity(step / FADE_STEPS)
          await sleep(FADE_STEP_MS)
        }
        window.destroy()
      }
      if (process.platform === 'darwin') await app.dock?.show()
      if (!main.isDestroyed()) {
        main.show()
        main.focus()
      }
    }
  }
}
