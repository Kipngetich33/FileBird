// End-to-end smoke test: launches the built app and drives the real renderer
// over CDP with real mouse and keyboard input, so the whole
// preload -> IPC -> main chain is exercised for real.
//
// Local pane: a fixture directory, used as the app's home via FLY_DEV_HOME
// (honoured by unpackaged builds only).
// Remote pane: a real OpenSSH server in a container (needs `colima start fly`),
// saved connections, the real macOS Keychain ("Fly (development)" namespace),
// and an ~/.ssh/config import from a fixture.
// The app runs with a throwaway --user-data-dir, so the real app data is never
// touched, and it is restarted once to prove secrets persist in the keychain.
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { startSftpServer } from '../test/support/sftp-container.ts'
import { TEST_PASSPHRASE, generateTestKeys, sshKeygenFingerprint } from '../test/support/ssh-keys.ts'

const run = promisify(execFile)
const PORT = 9222
/** Node inspector for the main process, used to click real application menu items. */
const INSPECT_PORT = 9339
const SHOT_DIR = process.env.SMOKE_SCREENSHOT_DIR
const KEYCHAIN_SERVICE = 'Fly (development)'
const ELECTRON = './node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const q = (value) => JSON.stringify(value)

const EXPECTED_LOCAL = ['.ssh', 'alpha', 'link-to-alpha', 'locked', '.hidden', 'broken-link', 'file2.txt', 'file10.txt']
const EXPECTED_REMOTE = ['alpha', 'link-to-alpha', 'locked', '.hidden', 'broken-link', 'file2.txt', 'file10.txt']

const LOCAL = '[aria-label="Local files"]'
const REMOTE = '[aria-label="Remote files"]'
const PANE = '[aria-label="Remote connection"]'
const NEW_FORM = '[aria-label="New connection"]'
const DIALOG = '[role="dialog"]'

const results = []
const record = (label, value, pass) =>
  results.push([label, typeof value === 'string' ? value : JSON.stringify(value), Boolean(pass)])

const mainLogs = []
let app
let server
let keys
let fixture
let userData
let scratch

// Data the smoke test must never write to.
// The installed app's data folder, and the one unpackaged runs use without --user-data-dir.
const realTrustStores = ['fly', 'Fly (development)'].map((folder) => join(homedir(), 'Library', 'Application Support', folder, 'known-hosts.json'))
const readTrustStores = () => Promise.all(realTrustStores.map((path) => readFile(path, 'utf8').catch(() => null)))
const realTrustBefore = JSON.stringify(await readTrustStores())

/** Whether a Keychain item exists, by attributes only: reading its value from here would prompt. */
async function keychainHas(account) {
  try {
    await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** Deletes Keychain items through the Electron binary that created them, which macOS allows without a prompt. */
async function deleteKeychainItems(accounts) {
  if (accounts.length === 0) return
  const script = `const { Entry } = require('@napi-rs/keyring'); for (const a of ${q(accounts)}) new Entry(${q(KEYCHAIN_SERVICE)}, a).deletePassword()`
  await run(ELECTRON, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 }).catch(() => undefined)
}

async function profileIds() {
  try {
    return JSON.parse(await readFile(join(userData, 'connections.json'), 'utf8')).connections.map((c) => c.id)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ app driver ---

async function launchApp() {
  // Electron honours ELECTRON_RUN_AS_NODE from the parent environment: if it is
  // set the binary runs main.js as a plain Node script and never opens a window.
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env
  const child = spawn('./node_modules/.bin/electron', [`--inspect=${INSPECT_PORT}`, '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // FLY_DEV_HOME, not HOME: macOS finds the login keychain through HOME.
    env: { ...inherited, FLY_DEV_HOME: fixture, FLY_DEV_TRASH_DIR: join(scratch, 'trash'), FLY_DEV_DOWNLOADS: join(scratch, 'downloads') }
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const launchedAt = Date.now()
  child.stdout.on('data', (d) => mainLogs.push(d.toString()))
  child.stderr.on('data', (d) => mainLogs.push(d.toString()))

  // Two pages appear at launch: the FileBird start screen and the (still hidden) main window.
  let page
  const splash = { seen: false, wordmark: null, canvas: false }
  for (let i = 0; i < 60 && (!page || !splash.seen); i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.includes('splash.html'))
      const splashPage = targets.find((t) => t.type === 'page' && t.url.includes('splash.html'))
      if (splashPage && !splash.seen) {
        splash.seen = true
        const probe = new WebSocket(splashPage.webSocketDebuggerUrl)
        await new Promise((r) => probe.addEventListener('open', r))
        const reply = new Promise((r) => probe.addEventListener('message', (ev) => r(JSON.parse(ev.data))))
        probe.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `new Promise((r) => setTimeout(() => r(JSON.stringify({ wordmark: document.querySelector('#wordmark span')?.textContent, canvas: !!document.querySelector('canvas#stream') })), 300))`, awaitPromise: true, returnByValue: true } }))
        Object.assign(splash, JSON.parse((await reply).result?.result?.value ?? '{}'))
        probe.close()
      }
    } catch {}
    if (!page || !splash.seen) await sleep(100)
  }
  if (!page) throw new Error('No page target appeared')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let nextId = 0
  const pending = new Map()
  const dragWaiters = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
    if (msg.method === 'Input.dragIntercepted') for (const resolve of dragWaiters.splice(0)) resolve(msg.params.data)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++nextId
      pending.set(n, resolve)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await send('Runtime.enable')

  // The main process, through its Node inspector: CDP key events never reach
  // native menu accelerators, but menu items can be clicked from here.
  let mainTarget
  for (let i = 0; i < 40 && !mainTarget; i++) {
    try {
      mainTarget = (await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json())[0]
    } catch {}
    if (!mainTarget) await sleep(250)
  }
  if (!mainTarget) throw new Error('Main-process inspector did not appear')
  const mainWs = new WebSocket(mainTarget.webSocketDebuggerUrl)
  await new Promise((r) => mainWs.addEventListener('open', r))
  let mainId = 0
  const mainPending = new Map()
  mainWs.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && mainPending.has(msg.id)) {
      mainPending.get(msg.id)(msg)
      mainPending.delete(msg.id)
    }
  })
  const mainEval = (expression) =>
    new Promise((resolve) => {
      const n = ++mainId
      mainPending.set(n, (msg) => resolve(msg.result?.result?.value))
      mainWs.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })

  const js = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = res.result?.exceptionDetails
    if (details) throw new Error(`renderer threw: ${JSON.stringify(details).slice(0, 300)}`)
    return res.result?.result?.value
  }

  // Floating over other apps and every Space, so it can't open out of sight.
  splash.floating = await mainEval(`JSON.stringify(process.mainModule.require('electron').BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('splash.html')).map((w) => ({ onTop: w.isAlwaysOnTop(), allSpaces: w.isVisibleOnAllWorkspaces() }))[0] ?? null)`)

  // The main window appears only once the start screen has had its time.
  let mainShownAfter = null
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await sleep(100)) {
    const visible = await mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => w.webContents.getURL().includes('splash.html') ? 'splash' : 'main').join(',')`)
    if (visible === 'main') {
      mainShownAfter = Date.now() - launchedAt
      break
    }
  }
  splash.mainShownAfter = mainShownAfter

  // Floating over full-screen apps hides the Dock icon and menu bar on macOS; the hand-off restores them.
  splash.dockVisibleAfter = false
  for (const deadline = Date.now() + 3000; Date.now() < deadline; await sleep(100)) {
    if (await mainEval(`process.mainModule.require('electron').app.dock?.isVisible() ?? true`)) {
      splash.dockVisibleAfter = true
      break
    }
  }

  // Focus events fire only in a focused page, and macOS does not always
  // activate an app launched from a background process (the relaunch often
  // isn't, and it can't take focus itself), so have the page act focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  // Counts the folder listings the renderer asks the server for, so a check can
  // see that clicking a folder again while it loads doesn't ask again.
  const listCounter = await mainEval(`(() => {
    const handlers = process.mainModule.require('electron').ipcMain._invokeHandlers
    const original = handlers?.get('sftp:list-directory')
    if (typeof original !== 'function') return 'missing'
    globalThis.__smokeListCalls = []
    handlers.set('sftp:list-directory', (event, ...args) => {
      globalThis.__smokeListCalls.push(args[1])
      return original(event, ...args)
    })
    return 'counting'
  })()`)

  // Showing a file would open Finder over everything; record what was asked for.
  await mainEval(`(() => {
    const { shell } = process.mainModule.require('electron')
    globalThis.__smokeRevealed = []
    const original = shell.showItemInFolder.bind(shell)
    shell.showItemInFolder = (path) => { globalThis.__smokeRevealed.push(path); return original === undefined ? undefined : undefined }
    return true
  })()`)

  // Native menus can't be driven over CDP: record each right-click menu Fly
  // pops up, and choose from it by label, as a person would.
  await mainEval(`(() => {
    const { Menu } = process.mainModule.require('electron')
    globalThis.__smokeContextMenus = []
    globalThis.__smokeContextPick = null
    Menu.prototype.popup = function (options) {
      globalThis.__smokeContextMenus.push(this.items.map((item) => (item.type === 'separator' ? '—' : item.label + (item.enabled ? '' : ' (off)'))))
      const pick = this.items.find((item) => item.label === globalThis.__smokeContextPick && item.enabled)
      globalThis.__smokeContextPick = null
      if (pick) pick.click()
      options?.callback?.()
    }
    return true
  })()`)

  const self = {
    splash,
    listCounter,
    send,
    js,
    mainEval,
    /**
     * Right-clicks an element (40px in from its left edge, or its centre) with a
     * real mouse event and returns the menu Fly showed, choosing `pick` from it.
     */
    async contextMenu(selector, pick = null, { centre = false } = {}) {
      const before = await mainEval(`globalThis.__smokeContextPick = ${JSON.stringify(pick)}; globalThis.__smokeContextMenus.length`)
      await js(`document.querySelector(${q(selector)}).scrollIntoView({ block: 'center' })`)
      const r = await js(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
      const x = centre ? r.x + r.w / 2 : r.x + 40
      const y = r.y + r.h / 2
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
      for (const deadline = Date.now() + 3000; Date.now() < deadline; await sleep(50)) {
        const menus = JSON.parse(await mainEval('JSON.stringify(globalThis.__smokeContextMenus)'))
        if (menus.length > before) return menus[menus.length - 1]
      }
      await mainEval('globalThis.__smokeContextPick = null')
      return null
    },
    /** Clicks an application menu item by id, exactly as choosing it from the menu bar would. */
    async clickMenu(id) {
      const result = await mainEval(`(() => { const item = process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById(${q(id)}); if (!item) return 'missing'; item.click(); return 'clicked' })()`)
      if (result !== 'clicked') throw new Error(`menu item ${id}: ${result}`)
      await sleep(150)
    },
    async mouseDrag(fromX, y, toX) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 })
      for (const step of [0.25, 0.5, 0.75, 1]) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + (toX - fromX) * step, y, button: 'left', buttons: 1 })
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 })
    },
    /** modifiers: 1 Alt, 2 Ctrl, 4 Meta (Cmd), 8 Shift. */
    async mouseClick(x, y, clickCount = 1, modifiers = 0) {
      for (let c = 1; c <= clickCount; c++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c, modifiers })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c, modifiers })
      }
    },
    /**
     * A real mouse drag: press and move over the source until Chromium starts a
     * drag (intercepted, so its data is known), then hover and drop through
     * CDP drag events. Returns hover/drop/cancel steps so a test can look
     * mid-drag.
     */
    async startDrag(from, to) {
      await send('Input.setInterceptDrags', { enabled: true })
      const intercepted = new Promise((resolve) => dragWaiters.push(resolve))
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      for (const step of [0.05, 0.2, 0.5, 1]) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step, y: from.y + (to.y - from.y) * step, button: 'left', buttons: 1 })
      }
      const data = await Promise.race([intercepted, sleep(3000).then(() => null)])
      const finish = async () => {
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
        await send('Input.setInterceptDrags', { enabled: false })
      }
      if (data === null) {
        await finish()
        throw new Error('the drag did not start')
      }
      return {
        data,
        hover: async (point = to) => {
          await send('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data })
          await send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data })
          await sleep(150)
        },
        drop: async (point = to) => {
          await send('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
          await finish()
          await sleep(150)
        }
      }
    },
    /** Clicks a button by its text with the real mouse. */
    async mouseClickButton(scope, text) {
      const point = await js(`(() => {
        const button = [...document.querySelectorAll(${q(`${scope} button`)})].find((b) => b.textContent.trim() === ${q(text)})
        if (!button) return null
        button.scrollIntoView({ block: 'nearest' })
        const r = button.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`)
      if (!point) throw new Error(`no button ${text} in ${scope}`)
      await self.mouseClick(point.x, point.y)
    },
    async evaluate(label, expression, check) {
      let value
      let pass = false
      try {
        value = await js(expression)
        pass = Boolean(check(value))
      } catch (error) {
        value = value ?? error.message
      }
      record(label, value, pass)
    },
    async waitFor(expression, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          if (await js(expression)) return true
        } catch {}
        await sleep(100)
      }
      return false
    },
    async doubleClick(selector) {
      await js(`document.querySelector(${q(selector)}).scrollIntoView({ block: 'center' })`)
      const box = await js(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`)
      for (const clickCount of [1, 2]) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount })
      }
    },
    /** Types into the terminal that has focus, as a person would, then Enter. */
    async typeInTerminal(scope, line) {
      await js(`document.querySelector(${q(`${scope} .xterm-helper-textarea`)})?.focus()`)
      await send('Input.insertText', { text: line })
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    },
    async press(key, code, keyCode, modifiers = 0) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
    },
    /** Real typing, replacing what the field holds. */
    async type(selector, text) {
      await js(`(() => { const el = document.querySelector(${q(selector)}); el.focus(); el.select?.() })()`)
      await send('Input.insertText', { text })
    },
    async click(scope, text) {
      await js(`(() => {
        const button = [...document.querySelectorAll(${q(`${scope} button`)})].find(b => b.textContent.trim() === ${q(text)})
        if (!button) throw new Error('no button ' + ${q(text)} + ' in ' + ${q(scope)})
        button.click()
      })()`)
    },
    async screenshot(name) {
      if (!SHOT_DIR) return
      await mkdir(SHOT_DIR, { recursive: true })
      const png = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(png.result.data, 'base64'))
    },
    /**
     * Asks the app to quit from inside (like Cmd+Q), then detaches both CDP
     * sessions: Node won't let a process exit while a debugger is attached.
     * Resolves true if it exited within `ms`.
     */
    async quitFromMenu(ms) {
      mainWs.send(JSON.stringify({ id: 999_999, method: 'Runtime.evaluate', params: { expression: `process.mainModule.require('electron').app.quit()` } }))
      await sleep(100)
      ws.close()
      mainWs.close()
      return Promise.race([exited.then(() => true), sleep(ms).then(() => false)])
    },
    /** Resolves true if the app exited by itself within 5 seconds of being asked to quit. */
    async close() {
      ws.close()
      mainWs.close()
      child.kill('SIGTERM')
      const quit = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
      if (!quit) {
        child.kill('SIGKILL')
        await Promise.race([exited, sleep(2000)])
      }
      return quit
    }
  }
  return self
}

const pathOf = (scope) => `document.querySelector(${q(`${scope} [data-testid="pane-path"]`)})?.textContent`
const rowFor = (path) => `[role="row"][data-path=${q(path)}]`
const rowNames = (scope) =>
  `JSON.stringify([...document.querySelectorAll(${q(`${scope} [role="row"][data-path]`)})].map(r => r.dataset.path.split('/').pop()))`
// Parenthesised: without them, `…?.textContent ?? ''.includes(x)` binds .includes to '' and always passes.
const alertIn = (scope) => `(document.querySelector(${q(`${scope} [role="alert"]`)})?.textContent ?? '')`
const textOf = (selector) => `(document.querySelector(${q(selector)})?.textContent ?? '')`
const exists = (selector) => `!!document.querySelector(${q(selector)})`
const SEPARATOR = '[role="separator"][aria-label="Resize panes"]'
const LOCAL_PANE_ACTIVE = `document.querySelector(${q(LOCAL)})?.dataset.active === 'true'`
const box = (selector) => `(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`
const splitValue = `Number(document.querySelector(${q(SEPARATOR)})?.getAttribute('aria-valuenow'))`
const leftSlotWidth = `document.querySelector(${q(SEPARATOR)}).previousElementSibling.getBoundingClientRect().width`
const insidePane = (scope) => `!!document.activeElement?.closest(${q(scope)})`
const profileRow = (name) => `[data-connection-name=${q(name)}]`
const codeFrom = (call) =>
  `(async () => { try { await ${call}; return 'NOT REJECTED' } catch (e) {
     const m = e.message; try { return JSON.parse(m.slice(m.indexOf('{'), m.lastIndexOf('}') + 1)).code } catch { return m }
   } })()`

try {
  // ---------------------------------------------------------------- fixtures ---

  fixture = await mkdtemp(join(tmpdir(), 'fly-smoke-'))
  scratch = await mkdtemp(join(tmpdir(), 'fly-smoke-scratch-'))
  // Where a download goes when it wasn't dragged somewhere (FLY_DEV_DOWNLOADS).
  await mkdir(join(scratch, 'downloads'), { recursive: true })
  userData = await mkdtemp(join(tmpdir(), 'fly-smoke-userdata-'))
  await mkdir(join(fixture, 'alpha'))
  await writeFile(join(fixture, 'file2.txt'), 'hello')
  await writeFile(join(fixture, 'file10.txt'), '')
  await writeFile(join(fixture, '.hidden'), '')
  await symlink(join(fixture, 'alpha'), join(fixture, 'link-to-alpha'))
  await symlink(join(fixture, 'missing'), join(fixture, 'broken-link'))
  await mkdir(join(fixture, 'locked'))
  await chmod(join(fixture, 'locked'), 0o000)
  await mkdir(join(fixture, '.ssh'))

  ;[server, keys] = await Promise.all([startSftpServer('smoke'), generateTestKeys()])
  await server.buildFixture()
  await server.authorizeKey(keys.keys['ed25519-encrypted'].publicKey)
  const keyPath = keys.keys['ed25519-encrypted'].path
  const marker = join(scratch, 'MATCH_EXEC_RAN')

  await writeFile(
    join(fixture, '.ssh', 'config'),
    [
      'Host smoke-imported',
      '  HostName 127.0.0.1',
      `  Port ${server.port}`,
      '  User fly',
      `  IdentityFile ${keyPath}`,
      'Host smoke-jumped',
      '  HostName 10.0.0.5',
      '  ProxyJump bastion.example.org',
      `Match exec "touch ${marker}"`,
      '  ServerAliveInterval 30'
    ].join('\n')
  )

  app = await launchApp()
  record(
    'start screen: FileBird shows its animated start screen first, floating over other apps and Spaces, then hands over to the main window after about 6 seconds, with the Dock icon and menu bar back',
    app.splash,
    app.splash.seen && app.splash.wordmark === 'FileBird' && app.splash.canvas && app.splash.mainShownAfter !== null && app.splash.mainShownAfter >= 5800 &&
      app.splash.floating === JSON.stringify({ onTop: true, allSpaces: true }) && app.splash.dockVisibleAfter
  )
  const rendered = await app.waitFor(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length > 0`)

  // ------------------------------------------------------------- architecture ---

  await app.evaluate('renderer mounted with both panes', `${exists(LOCAL)} && ${exists(PANE)}`, (v) => v === true)
  await app.evaluate(
    'bridge exposes exactly the approved methods',
    `JSON.stringify(Object.fromEntries(Object.entries(window.api).map(([k, v]) => [k, Object.keys(v).sort()]).sort()))`,
    (v) =>
      v ===
      JSON.stringify({
        app: ['onMenuCommand', 'showContextMenu'],
        connections: ['connect', 'connectUnsaved', 'create', 'delete', 'forgetSecret', 'list', 'update'],
        files: ['createFolder', 'delete', 'move', 'rename'],
        keys: ['inspect', 'pick'],
        local: ['getDownloadFolder', 'getStartDirectory', 'listDirectory'],
        sftp: ['disconnect', 'forgetHostKey', 'listDirectory', 'onConnectionClosed', 'trustHostKeyAndConnect'],
        sshConfig: ['import', 'preview'],
        system: ['getVersion', 'revealInFolder'],
        terminals: ['acknowledge', 'close', 'onData', 'onExit', 'open', 'resize', 'setFocus', 'write'],
        transfers: ['cancel', 'cancelAll', 'clearFinished', 'list', 'onUpdate', 'retry', 'retryFailed', 'start']
      })
  )
  await app.evaluate('context menu: a request with an unknown action is INVALID_INPUT', codeFrom(`window.api.app.showContextMenu([{ action: 'format-disk', enabled: true }])`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('node hidden', `[window.require, window.process, window.module].every(v => v === undefined)`, (v) => v === true)
  await app.evaluate('tailwind applied', `getComputedStyle(document.body).backgroundColor`, (v) => v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent')

  // ------------------------------------------------------- local files over IPC ---

  await app.evaluate('getStartDirectory (the fixture folder here; the Downloads folder in a real run)', `window.api.local.getStartDirectory()`, (v) => v === fixture)
  await app.evaluate(
    'listDirectory describes the fixture',
    `(async () => JSON.stringify(await window.api.local.listDirectory(${q(fixture)})))()`,
    (v) => {
      const listing = JSON.parse(v)
      const by = Object.fromEntries(listing.entries.map((e) => [e.name, e]))
      return (
        listing.path === fixture &&
        listing.parentPath === dirname(fixture) &&
        Object.keys(by).sort().join() === [...EXPECTED_LOCAL].sort().join() &&
        by['file2.txt'].size === 5 &&
        by['link-to-alpha'].kind === 'directory' && by['link-to-alpha'].isSymlink &&
        by['broken-link'].kind === 'other' && by['.hidden'].isHidden
      )
    }
  )
  await app.evaluate('rejects a relative path', codeFrom(`window.api.local.listDirectory('relative/path')`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('rejects a non-string path', codeFrom(`window.api.local.listDirectory(42)`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('unreadable folder is PERMISSION_DENIED', codeFrom(`window.api.local.listDirectory(${q(join(fixture, 'locked'))})`), (v) => v === 'PERMISSION_DENIED')
  await app.evaluate('rejects a relative key path', codeFrom(`window.api.keys.inspect('id_ed25519')`), (v) => v === 'INVALID_INPUT')
  await app.evaluate(
    'rejects a connection with an unknown auth type',
    codeFrom(`window.api.connections.create({ name: 'x', host: 'h', port: 22, username: 'u', auth: { type: 'agent' } })`),
    (v) => v === 'INVALID_INPUT'
  )

  // ------------------------------------------------ the local pane, like a user ---

  record('UI local: pane rendered rows', String(rendered), rendered)
  await app.evaluate('UI local: folders first, natural order', rowNames(LOCAL), (v) => v === JSON.stringify(EXPECTED_LOCAL))

  const rowCentre = async (path) => {
    await app.js(`document.querySelector(${q(rowFor(path))}).scrollIntoView({ block: 'center' })`)
    const r = await app.js(box(rowFor(path)))
    return { x: r.x + 40, y: r.y + r.h / 2 }
  }
  // Two folders inside alpha, so a double-click's second click would land on one of them.
  await mkdir(join(fixture, 'alpha', 'a-inner'))
  await mkdir(join(fixture, 'alpha', 'b-inner'))
  const alphaPoint = await rowCentre(join(fixture, 'alpha'))
  await app.mouseClick(alphaPoint.x, alphaPoint.y)
  record('UI local: a single click opens a folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))
  await app.js(`document.querySelector(${q(`${LOCAL} button[aria-label="Back"]`)}).click()`)
  record(
    'UI local: Back returns and reselects the folder',
    await app.js(pathOf(LOCAL)),
    await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)} && document.querySelector(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})?.dataset.path === ${q(join(fixture, 'alpha'))}`)
  )
  await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
  await app.press('Enter', 'Enter', 13)
  record('UI local: Enter opens the selected folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))
  await app.press('Backspace', 'Backspace', 8)
  record('UI local: Backspace goes to the parent folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)}`))

  // A double-click out of habit: the first click opens alpha; the second, arriving
  // after alpha's rows are showing, lands on a folder inside it and must not open that.
  const habit = await rowCentre(join(fixture, 'alpha'))
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: habit.x, y: habit.y, button: 'left', buttons: 1, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: habit.x, y: habit.y, button: 'left', buttons: 0, clickCount: 1 })
  await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))} && ${exists(rowFor(join(fixture, 'alpha', 'b-inner')))}`)
  const underPointer = await app.js(`document.elementFromPoint(${habit.x}, ${habit.y})?.closest('[role="row"]')?.dataset.path ?? null`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: habit.x, y: habit.y, button: 'left', buttons: 1, clickCount: 2 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: habit.x, y: habit.y, button: 'left', buttons: 0, clickCount: 2 })
  await sleep(400)
  record(
    'UI local: a double-click opens the folder once, not the folder that lands under the pointer',
    { underPointer, path: await app.js(pathOf(LOCAL)) },
    underPointer !== null && underPointer.startsWith(join(fixture, 'alpha') + '/') && (await app.js(pathOf(LOCAL))) === join(fixture, 'alpha')
  )
  await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
  await app.press('Backspace', 'Backspace', 8)
  await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)}`)
  await rm(join(fixture, 'alpha', 'a-inner'), { recursive: true })
  await rm(join(fixture, 'alpha', 'b-inner'), { recursive: true })

  const cmdPoint = await rowCentre(join(fixture, 'link-to-alpha'))
  await app.mouseClick(cmdPoint.x, cmdPoint.y, 1, 4 /* Cmd */)
  await sleep(300)
  record(
    'UI local: Cmd-click selects a folder without opening it',
    { path: await app.js(pathOf(LOCAL)), selected: await app.js(`[...document.querySelectorAll(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})].map((row) => row.dataset.path)`) },
    (await app.js(pathOf(LOCAL))) === fixture &&
      (await app.js(`[...document.querySelectorAll(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})].map((row) => row.dataset.path)`)).includes(join(fixture, 'link-to-alpha'))
  )
  await writeFile(join(fixture, 'added-later.txt'), '')
  await app.press('F5', 'F5', 116)
  record('UI local: F5 refreshes the listing', '', await app.waitFor(exists(rowFor(join(fixture, 'added-later.txt')))))
  await app.doubleClick(rowFor(join(fixture, 'locked')))
  await app.waitFor(`${alertIn(LOCAL)} !== ''`)
  await app.evaluate('UI local: unreadable folder shows a friendly error', alertIn(LOCAL), (v) => /permission/i.test(v) && !/Error invoking|{/.test(v))

  // ------------------------------------------------ M5: application menu ---

  const menu = JSON.parse(
    await app.mainEval(`JSON.stringify((() => {
      const walk = (items, parent) => items.flatMap((i) => [{ parent, label: i.label, role: (i.role ?? '').toLowerCase(), id: i.id ?? null, accelerator: i.accelerator ?? null }, ...(i.submenu ? walk(i.submenu.items, i.label) : [])])
      return walk(process.mainModule.require('electron').Menu.getApplicationMenu().items, '')
    })())`)
  )
  const byId = Object.fromEntries(menu.filter((i) => i.id).map((i) => [i.id, i]))
  record(
    'menu: the default Reload is gone; Refresh is CmdOrCtrl+R; reload and DevTools only under Developer',
    { refresh: byId['command:refresh'], developer: menu.filter((i) => i.parent === 'Developer').map((i) => i.role) },
    !menu.some((i) => i.role === 'reload') &&
      byId['command:refresh']?.accelerator === 'CmdOrCtrl+R' && byId['command:refresh']?.parent === 'View' &&
      menu.filter((i) => ['forcereload', 'toggledevtools'].includes(i.role)).every((i) => i.parent === 'Developer') &&
      ['undo', 'cut', 'copy', 'paste'].every((role) => menu.some((i) => i.role === role && i.parent === 'Edit'))
  )

  // ------------------------------------------------------ M5: splitter ---

  const separatorBox = await app.js(box(SEPARATOR))
  const sepX = separatorBox.x + separatorBox.w / 2
  const sepY = separatorBox.y + separatorBox.h / 2
  record('splitter: starts at 50/50', await app.js(splitValue), (await app.js(splitValue)) === 50)

  const widthBefore = await app.js(leftSlotWidth)
  await app.mouseDrag(sepX, sepY, sepX + 150)
  const widthAfter = await app.js(leftSlotWidth)
  record('splitter: dragging with the mouse widens the local pane by the drag distance', { widthBefore, widthAfter }, Math.abs(widthAfter - widthBefore - 150) <= 4)

  const dragged = await app.js(box(SEPARATOR))
  await app.mouseDrag(dragged.x + dragged.w / 2, sepY, 5)
  const narrowest = await app.js(leftSlotWidth)
  record('splitter: a pane cannot be dragged narrower than 320px', narrowest, narrowest >= 319.5 && narrowest <= 330)

  const resetBox = await app.js(box(SEPARATOR))
  await app.mouseClick(resetBox.x + resetBox.w / 2, sepY, 2)
  const afterReset = await app.js(splitValue)
  await app.js(`document.querySelector(${q(SEPARATOR)})?.focus()`)
  for (let i = 0; i < 5; i++) await app.press('ArrowRight', 'ArrowRight', 39)
  const expectedSplit = await app.js(splitValue)
  record('splitter: double-click resets to 50, and → moves it in 2% steps', { afterReset, expectedSplit }, afterReset === 50 && expectedSplit === 60)

  // ------------------------------------------------- M5: active pane ---

  await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
  record('active pane: the local pane is active once focused', await app.js(textOf('[data-testid="status-active-pane"]')), (await app.js(LOCAL_PANE_ACTIVE)) && (await app.js(`document.querySelector(${q(PANE)})?.dataset.active === 'false'`)))

  const remoteBox = await app.js(box(PANE))
  await app.mouseClick(remoteBox.x + 60, remoteBox.y + 20)
  record(
    'active pane: clicking the remote pane makes it active and the local pane inactive',
    await app.js(textOf('[data-testid="status-active-pane"]')),
    (await app.waitFor(`document.querySelector(${q(PANE)})?.dataset.active === 'true'`)) && !(await app.js(LOCAL_PANE_ACTIVE)) &&
      (await app.js(textOf('[data-testid="status-active-pane"]'))) === 'Remote'
  )

  await app.clickMenu('command:focus-local')
  record('menu: View › Focus Local Pane focuses and activates the local pane', '', (await app.waitFor(LOCAL_PANE_ACTIVE)) && (await app.js(insidePane(LOCAL))))
  await app.clickMenu('command:focus-remote')
  record('menu: View › Focus Remote Pane focuses and activates the remote pane', '', (await app.waitFor(`document.querySelector(${q(PANE)})?.dataset.active === 'true'`)) && (await app.js(insidePane(PANE))))

  await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
  await app.press('Tab', 'Tab', 9)
  const tabbedToRemote = (await app.waitFor(insidePane(PANE))) && (await app.js(`document.querySelector(${q(PANE)})?.dataset.active === 'true'`))
  await app.press('Tab', 'Tab', 9, 8)
  const shiftTabbedBack = (await app.waitFor(`document.activeElement === document.querySelector(${q(LOCAL)})`)) && (await app.js(LOCAL_PANE_ACTIVE))
  record('keyboard: Tab from the local list moves to the remote pane, Shift+Tab comes back', { tabbedToRemote, shiftTabbedBack }, tabbedToRemote && shiftTabbedBack)

  await app.js(`window.__refreshButton = document.querySelector(${q(`${LOCAL} button[aria-label="Refresh"]`)}); window.__refreshButton.focus()`)
  await app.press('Tab', 'Tab', 9)
  await sleep(150)
  record(
    'keyboard: Tab from a toolbar button moves to the next control, not to the other pane',
    await app.js(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName`),
    (await app.js(`document.activeElement !== window.__refreshButton && document.activeElement !== document.body`)) && !(await app.js(insidePane(PANE)))
  )

  // ------------------------------------------------------ M5: footers ---

  await app.js(`document.querySelector(${q(rowFor(join(fixture, 'file2.txt')))}).click()`)
  await app.evaluate(
    'footer: the local pane shows its item count and the selected file',
    `JSON.stringify({ count: ${textOf(`${LOCAL} [data-testid="pane-count"]`)}, selection: ${textOf(`${LOCAL} [data-testid="pane-selection"]`)} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.count === `${EXPECTED_LOCAL.length + 1} items` && d.selection === 'file2.txt · 5 bytes'
    }
  )

  // ------------------------------------------ saved key connection, first time ---

  record('UI connections: empty list invites adding or importing', '', await app.waitFor(`${textOf(PANE)}.includes('No saved connections yet')`))

  await app.click(PANE, 'New connection')
  await app.waitFor(exists(NEW_FORM))
  await app.type(`${NEW_FORM} input[name="name"]`, 'Smoke key')
  await app.type(`${NEW_FORM} input[name="host"]`, server.host)
  await app.type(`${NEW_FORM} input[name="port"]`, String(server.port))
  await app.type(`${NEW_FORM} input[name="username"]`, server.username)
  await app.type(`${NEW_FORM} input[name="privateKeyPath"]`, keyPath)
  const keyFingerprint = await sshKeygenFingerprint(keyPath)
  const keyInfoShown = await app.waitFor(`${textOf('[data-testid="key-info"]')}.includes('passphrase-protected')`)
  const keyInfo = await app.js(textOf('[data-testid="key-info"]'))
  await app.screenshot('1-new-key-connection')
  record('UI form: an encrypted key is described with OpenSSH’s fingerprint', keyInfo, keyInfoShown && keyInfo.includes('ssh-ed25519') && keyInfo.includes(keyFingerprint))

  await app.click(NEW_FORM, 'Save & connect')
  const passphraseAsked = await app.waitFor(exists('input[name="secret"]'), 15000)
  await app.screenshot('2-passphrase-prompt')
  record('UI connect: an unsaved passphrase is asked for', await app.js(textOf(DIALOG)), passphraseAsked && (await app.js(textOf(DIALOG))).includes('Passphrase for ed25519-encrypted'))

  await app.type('input[name="secret"]', 'not the passphrase')
  await app.js(`document.querySelector('input[name="remember"]').click()`)
  await app.click(DIALOG, 'Connect')
  const rejected = await app.waitFor(`${alertIn(DIALOG)}.includes('incorrect')`, 15000)
  record('UI connect: a wrong passphrase is reported as such, and asked again', await app.js(alertIn(DIALOG)), rejected)

  await app.type('input[name="secret"]', TEST_PASSPHRASE)
  await app.js(`document.querySelector('input[name="remember"]').click()`)
  await app.click(DIALOG, 'Connect')
  const prompted = await app.waitFor(exists('[data-testid="host-key-fingerprint"]'), 15000)
  const shownFingerprint = await app.js(textOf('[data-testid="host-key-fingerprint"]'))
  const keyscan = await server.keyscanFingerprints()
  record('UI connect: first contact shows the host key fingerprint OpenSSH reports', { shownFingerprint, keyscan }, prompted && keyscan.includes(shownFingerprint))

  await app.click(DIALOG, 'Trust and connect')
  const connected = await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000)
  await app.evaluate(
    'UI connect: key login succeeds and lands in the home folder',
    `JSON.stringify({ connected: ${connected}, subtitle: ${textOf(`${REMOTE} [data-testid="pane-subtitle"]`)}, title: ${textOf('header')} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.connected && d.subtitle === `fly@127.0.0.1:${server.port}` && d.title.includes('Connected to fly@127.0.0.1')
    }
  )

  // ------------------------------------------------- what was stored, and where ---

  const [keyProfileId] = await profileIds()
  const connectionsFile = await readFile(join(userData, 'connections.json'), 'utf8').catch(() => '')
  record(
    'storage: connections.json holds the profile but no passphrase, owner-only',
    { hasProfile: connectionsFile.includes('Smoke key'), mode: ((await stat(join(userData, 'connections.json'))).mode & 0o777).toString(8) },
    connectionsFile.includes('Smoke key') && !connectionsFile.includes(TEST_PASSPHRASE) && !connectionsFile.includes('not the passphrase') &&
      ((await stat(join(userData, 'connections.json'))).mode & 0o777) === 0o600
  )
  const passphraseAccount = `connection/${keyProfileId}/passphrase`
  record('storage: the passphrase is a Keychain item (checked by attributes only)', passphraseAccount, await keychainHas(passphraseAccount))
  record('storage: the real app data (installed and development) was not touched', '', JSON.stringify(await readTrustStores()) === realTrustBefore)

  // ------------------------------------------------- browsing, then losing it ---

  await app.waitFor(exists(rowFor('/config/fixture')))
  await app.doubleClick(rowFor('/config/fixture'))
  await app.waitFor(exists(rowFor('/config/fixture/alpha')))
  await app.evaluate('UI remote: lists the server folder, folders first', rowNames(REMOTE), (v) => v === JSON.stringify(EXPECTED_REMOTE))
  await app.doubleClick(rowFor('/config/fixture/locked'))
  await app.waitFor(`${alertIn(REMOTE)} !== ''`)
  await app.evaluate('UI remote: unreadable server folder shows a friendly error', alertIn(REMOTE), (v) => /permission/i.test(v))

  await server.killSessions()
  const lost = await app.waitFor(`${alertIn(PANE)}.includes('Network connection lost')`, 10000)
  record('UI remote: a dropped connection returns to the list and says so', await app.js(alertIn(PANE)), lost && (await app.js(exists(profileRow('Smoke key')))))
  await app.evaluate('UI list: the saved passphrase is shown as saved', textOf(`${profileRow('Smoke key')} [data-testid="saved-secret"]`), (v) => v === 'passphrase saved')

  // -------------------------------------------- restart: secrets persist in keychain ---

  record('restart: the app quits promptly when asked (before-quit cleanup does not hang)', '', await app.close())
  app = await launchApp()
  await app.waitFor(exists(profileRow('Smoke key')), 10000)
  await app.js(`document.querySelector(${q(`${profileRow('Smoke key')}`)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  let sawPrompt = false
  let reconnected = false
  for (const deadline = Date.now() + 15000; Date.now() < deadline && !reconnected; ) {
    sawPrompt = sawPrompt || (await app.js(exists(DIALOG)))
    reconnected = await app.js(`${pathOf(REMOTE)} === '/config'`)
    if (!reconnected) await sleep(100)
  }
  record('restart: the saved connection connects with no passphrase or host key prompt', { reconnected, sawPrompt }, reconnected && !sawPrompt)
  record('splitter: the position is remembered across a restart', await app.js(splitValue), (await app.js(splitValue)) === expectedSplit)

  // ------------------------------------------- M5: menu commands, active pane only ---

  await app.js(`window.__smokeMarker = 'still here'`)
  await writeFile(join(fixture, 'menu-refresh-local.txt'), '')
  await server.exec(': > /config/menu-refresh-remote.txt && chown 1000:1000 /config/menu-refresh-remote.txt')
  record('active pane: connecting makes the remote pane active', await app.js(textOf('[data-testid="status-active-pane"]')), await app.waitFor(`document.querySelector(${q(REMOTE)})?.dataset.active === 'true'`))

  await app.clickMenu('command:refresh')
  const remoteRefreshed = await app.waitFor(exists(rowFor('/config/menu-refresh-remote.txt')))
  await sleep(800)
  const localUntouched = !(await app.js(exists(rowFor(join(fixture, 'menu-refresh-local.txt')))))
  record('menu: View › Refresh refreshes only the active (remote) pane', { remoteRefreshed, localUntouched }, remoteRefreshed && localUntouched)

  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  const localRefreshed = await app.waitFor(exists(rowFor(join(fixture, 'menu-refresh-local.txt'))))
  record('menu: after Focus Local, Refresh refreshes the local pane', '', localRefreshed)
  record('menu: no menu command reloaded the window', await app.js('window.__smokeMarker ?? null'), (await app.js('window.__smokeMarker ?? null')) === 'still here')

  const localPathBefore = await app.js(pathOf(LOCAL))
  await app.doubleClick(rowFor('/config/fixture'))
  await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  await app.clickMenu('command:go-up')
  const remoteUp = await app.waitFor(`${pathOf(REMOTE)} === '/config'`)
  await app.clickMenu('command:go-back')
  const remoteBack = await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  record(
    'menu: Go › Parent Folder and Go › Back act on the active pane only',
    { remoteUp, remoteBack, local: await app.js(pathOf(LOCAL)) },
    remoteUp && remoteBack && (await app.js(pathOf(LOCAL))) === localPathBefore
  )

  // ------------------------------------------------- M5: footers per pane ---

  await app.waitFor(exists(rowFor('/config/fixture/file2.txt')))
  await app.js(`document.querySelector(${q(rowFor('/config/fixture/file2.txt'))}).click()`)
  const alphaMenu = await app.contextMenu(rowFor(join(fixture, 'alpha')))
  await app.evaluate(
    'footer: each pane shows its own count and selection',
    `JSON.stringify({ local: ${textOf(`${LOCAL} [data-testid="pane-selection"]`)}, remote: ${textOf(`${REMOTE} [data-testid="pane-selection"]`)}, remoteCount: ${textOf(`${REMOTE} [data-testid="pane-count"]`)} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.local === 'alpha · Folder' && d.remote === 'file2.txt · 5 bytes' && d.remoteCount === `${EXPECTED_REMOTE.length} items`
    }
  )

  // ------------------------------------------------------- right-click menus ---

  record(
    'context menu: right-clicking a local folder selects it and offers Open, Upload, New Folder, Rename, Move to Trash and Refresh',
    { alphaMenu, path: await app.js(pathOf(LOCAL)) },
    JSON.stringify(alphaMenu) === JSON.stringify(['Open', '—', 'Upload', '—', 'New Folder', 'Rename…', 'Move to Trash…', '—', 'Refresh']) &&
      (await app.js(pathOf(LOCAL))) === fixture
  )
  const remoteFileMenu = await app.contextMenu(rowFor('/config/fixture/file2.txt'))
  record(
    'context menu: a remote file offers Download and a permanent Delete, and no Open',
    remoteFileMenu,
    JSON.stringify(remoteFileMenu) === JSON.stringify(['Download', '—', 'New Folder', 'Rename…', 'Delete…', '—', 'Refresh'])
  )
  await app.contextMenu(rowFor(join(fixture, 'alpha')))
  await app.mouseClick((await rowCentre(join(fixture, 'file2.txt'))).x, (await rowCentre(join(fixture, 'file2.txt'))).y, 1, 4 /* Cmd */)
  const selectionMenu = await app.contextMenu(rowFor(join(fixture, 'file2.txt')))
  record(
    'context menu: right-clicking inside a selection keeps it, and acts on all of it (no Rename for two)',
    { selectionMenu, footer: await app.js(textOf(`${LOCAL} [data-testid="pane-selection"]`)) },
    JSON.stringify(selectionMenu) === JSON.stringify(['Upload', '—', 'New Folder', 'Rename… (off)', 'Move to Trash…', '—', 'Refresh']) &&
      (await app.js(textOf(`${LOCAL} [data-testid="pane-selection"]`))).startsWith('2 selected')
  )
  // A plain click on a file makes it the only selection again.
  await app.mouseClick((await rowCentre(join(fixture, 'file2.txt'))).x, (await rowCentre(join(fixture, 'file2.txt'))).y)
  await app.contextMenu(rowFor(join(fixture, 'alpha')), 'Open')
  const openedFromMenu = await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`)
  const emptyMenu = await app.contextMenu(`${LOCAL} [data-testid="file-list"] p`, 'New Folder', { centre: true })
  const newFolderAsked = await app.waitFor(`${textOf(DIALOG)}.includes('New folder')`)
  await app.mouseClickButton(DIALOG, 'Cancel')
  await app.waitFor(`!${exists(DIALOG)}`)
  record(
    'context menu: Open opens the folder; the empty part of a list offers New Folder and Refresh, and New Folder asks for a name',
    { openedFromMenu, emptyMenu, newFolderAsked },
    openedFromMenu && newFolderAsked && JSON.stringify(emptyMenu) === JSON.stringify(['New Folder', '—', 'Refresh'])
  )
  await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
  await app.press('Backspace', 'Backspace', 8)
  await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)}`)
  await app.contextMenu(rowFor(join(fixture, 'file10.txt')), 'Rename…')
  const renameAsked = await app.waitFor(`document.querySelector('input[name="item-name"]')?.value === 'file10.txt'`)
  await app.mouseClickButton(DIALOG, 'Cancel')
  await app.waitFor(`!${exists(DIALOG)}`)
  await app.contextMenu(rowFor(join(fixture, 'file10.txt')), 'Move to Trash…')
  const trashAskedFromMenu = await app.waitFor(`${textOf(DIALOG)}.includes('Move "file10.txt" to the Trash?')`)
  await app.mouseClickButton(DIALOG, 'Cancel')
  await app.waitFor(`!${exists(DIALOG)}`)
  record(
    'context menu: Rename… and Move to Trash… open their dialogs for the right-clicked file',
    { renameAsked, trashAskedFromMenu },
    renameAsked && trashAskedFromMenu && (await stat(join(fixture, 'file10.txt')).then(() => true, () => false))
  )

  // ------------------------------------------------ M6–M7: transfers and the queue ---

  const PANEL = '[data-testid="transfer-panel"]'
  const UPLOAD_BUTTON = '[data-testid="upload-button"]'
  const META = 4
  const SHIFT = 8
  const jobRow = (name) => `${PANEL} li[data-name=${q(name)}]`
  const jobStatus = (name) => `document.querySelector(${q(jobRow(name))})?.dataset.status`
  const jobsWith = (status) => `document.querySelectorAll(${q(`${PANEL} li[data-status="${status}"]`)}).length`
  const allDone = (names) => names.map((name) => `${jobStatus(name)} === 'completed'`).join(' && ')
  const selectRow = async (path, modifiers = 0) => {
    await app.waitFor(exists(rowFor(path)), 10000)
    // A plain click opens a folder; right-clicking is how a person selects just it.
    if (modifiers === 0 && (await app.js(`document.querySelector(${q(rowFor(path))}).dataset.kind === 'directory'`))) {
      await app.contextMenu(rowFor(path))
      return
    }
    await app.js(`document.querySelector(${q(rowFor(path))}).scrollIntoView({ block: 'center' })`)
    const r = await app.js(box(rowFor(path)))
    await app.mouseClick(r.x + 40, r.y + r.h / 2, 1, modifiers)
  }
  const localFooter = textOf(`${LOCAL} [data-testid="pane-selection"]`)
  const FAKE_ID = '5b7c1f7e-7a51-4a5f-9a43-3f1d8c2b9e10'
  const localTree = async (root) => {
    const lines = []
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          lines.push(`${relative(root, path)}/`)
          await walk(path)
        } else if (entry.isFile()) lines.push(`${relative(root, path)} ${sha256(await readFile(path))}`)
      }
    }
    await walk(root)
    return lines.sort()
  }
  const serverTree = async (root) =>
    (await server.exec(`cd "${root}" && find . -mindepth 1 -type d | sed 's|^\\./||; s|$|/|' && find . -type f | while IFS= read -r f; do p="\${f#./}"; echo "$p $(sha256sum "$f" | cut -d' ' -f1)"; done`))
      .split('\n').filter(Boolean).sort()
  const makeZeros = (path, megabytes) => run('dd', ['if=/dev/zero', `of=${path}`, 'bs=1048576', `count=${megabytes}`])

  record(
    'menu: Transfer to Other Pane is CmdOrCtrl+T; Edit › Select All is a command (so file lists get Cmd+A)',
    { transfer: byId['command:transfer'], selectAll: byId['command:select-all'] },
    byId['command:transfer']?.accelerator === 'CmdOrCtrl+T' && byId['command:transfer']?.parent === 'Transfer' &&
      byId['command:select-all']?.accelerator === 'CmdOrCtrl+A' && byId['command:select-all']?.parent === 'Edit'
  )
  const startCall = (fields) => codeFrom(`window.api.transfers.start(${JSON.stringify({ connectionId: FAKE_ID, direction: 'upload', sourcePaths: [join(fixture, 'file2.txt')], destinationDirectory: '/config', onConflict: 'ask', ...fields })})`)
  await app.evaluate('transfers: a malformed connection id is INVALID_INPUT', startCall({ connectionId: 'nope' }), (v) => v === 'INVALID_INPUT')
  await app.evaluate('transfers: an empty selection is INVALID_INPUT', startCall({ sourcePaths: [] }), (v) => v === 'INVALID_INPUT')
  await app.evaluate('transfers: a relative local path is INVALID_INPUT', startCall({ direction: 'download', sourcePaths: ['/config/x'], destinationDirectory: 'Downloads' }), (v) => v === 'INVALID_INPUT')
  await app.evaluate('transfers: an unknown connection is NOT_CONNECTED', startCall({}), (v) => v === 'NOT_CONNECTED')
  await app.evaluate('transfers: retrying an unknown job is NOT_FOUND', codeFrom(`window.api.transfers.retry(${q(FAKE_ID)})`), (v) => v === 'NOT_FOUND')

  // One file, with the toolbar button and the real mouse.
  const uploadData = randomBytes(8_000_000)
  await writeFile(join(fixture, 'upload-me.bin'), uploadData)
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'upload-me.bin'))
  await app.waitFor(`document.querySelector(${q(UPLOAD_BUTTON)})?.disabled === false`)
  const uploadBox = await app.js(box(UPLOAD_BUTTON))
  await app.mouseClick(uploadBox.x + uploadBox.w / 2, uploadBox.y + uploadBox.h / 2)
  const uploaded = await app.waitFor(`${jobStatus('upload-me.bin')} === 'completed'`, 30000)
  const uploadedRemoteSha = (await server.exec('sha256sum /config/fixture/upload-me.bin')).split(' ')[0]
  const uploadListed = await app.waitFor(exists(rowFor('/config/fixture/upload-me.bin')), 10000)
  record(
    'UI transfer: Upload queues the selected file, it completes intact, and the remote pane shows it',
    { uploaded, sameContent: uploadedRemoteSha === sha256(uploadData), uploadListed },
    uploaded && uploadedRemoteSha === sha256(uploadData) && uploadListed
  )

  // One file the other way, with the menu command from the active remote pane.
  await server.exec('head -c 4000000 /dev/urandom > /config/fixture/from-server.bin && chown 1000:1000 /config/fixture/from-server.bin')
  await app.clickMenu('command:focus-remote')
  await app.clickMenu('command:refresh')
  await selectRow('/config/fixture/from-server.bin')
  await app.clickMenu('command:transfer')
  const downloaded = await app.waitFor(`${jobStatus('from-server.bin')} === 'completed'`, 30000)
  const serverSha = (await server.exec('sha256sum /config/fixture/from-server.bin')).split(' ')[0]
  const downloads = join(scratch, 'downloads')
  const localSha = sha256(await readFile(join(downloads, 'from-server.bin')).catch(() => Buffer.alloc(0)))
  // It goes to the downloads folder, not to the folder the local pane happens to show.
  const inPaneFolder = await stat(join(fixture, 'from-server.bin')).then(() => true, () => false)
  record(
    'UI transfer: a download nobody dragged goes to the downloads folder, intact, and not to the folder the pane is showing',
    {
      downloaded,
      sameContent: serverSha === localSha,
      inDownloads: (await readdir(downloads)).includes('from-server.bin'),
      inPaneFolder,
      leftovers: (await readdir(downloads)).filter((name) => name.includes('fly-part'))
    },
    downloaded && serverSha === localSha && !inPaneFolder && (await readdir(downloads)).every((name) => !name.includes('fly-part'))
  )
  const showButton = `${jobRow('from-server.bin')} [data-testid="panel-show"]`
  await app.waitFor(exists(showButton), 10000)
  const showTitle = await app.js(`document.querySelector(${q(showButton)})?.title ?? ''`)
  const showBox = await app.js(box(showButton))
  await app.mouseClick(showBox.x + showBox.w / 2, showBox.y + showBox.h / 2)
  await sleep(500)
  const revealed = JSON.parse(await app.mainEval('JSON.stringify(globalThis.__smokeRevealed ?? [])'))
  record(
    'UI transfer: a finished transfer offers Show, which opens the file manager at the file itself',
    { showTitle, revealed },
    showTitle.startsWith('Show in Finder: ') && revealed.length === 1 && revealed[0] === join(scratch, 'downloads', 'from-server.bin')
  )

  await app.evaluate(
    'UI transfer: the Download button says where it will put them',
    `document.querySelector(${q(`${REMOTE} [data-testid="download-button"]`)})?.title ?? ''`,
    (v) => v.includes(join(scratch, 'downloads'))
  )

  // One conflict: asked first, then Replace, then Keep both.
  await writeFile(join(fixture, 'conflict.txt'), 'new local content')
  await server.exec('printf old > /config/fixture/conflict.txt && chown 1000:1000 /config/fixture/conflict.txt')
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'conflict.txt'))
  await app.clickMenu('command:transfer')
  const conflictShown = await app.waitFor(exists('[data-testid="conflict-existing"]'), 10000)
  await app.screenshot('6-transfer-conflict')
  const conflictFacts = {
    focused: await app.js(`document.activeElement?.textContent ?? ''`),
    existing: await app.js(textOf('[data-testid="conflict-existing"]')),
    incoming: await app.js(textOf('[data-testid="conflict-incoming"]')),
    skipOffered: await app.js(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Skip')`),
    serverStill: await server.exec('cat /config/fixture/conflict.txt')
  }
  record(
    'UI conflict: an existing file is not touched until the user chooses; Cancel is focused; no Skip for a lone item',
    conflictFacts,
    conflictShown && conflictFacts.focused === 'Cancel' && conflictFacts.existing.includes('3 bytes') && conflictFacts.incoming.includes('17 bytes') && !conflictFacts.skipOffered && conflictFacts.serverStill === 'old'
  )
  await app.mouseClickButton(DIALOG, 'Replace')
  await app.waitFor(`${jobsWith('completed')} === 3`, 15000)
  record('UI conflict: Replace overwrites the server copy', await server.exec('cat /config/fixture/conflict.txt'), (await server.exec('cat /config/fixture/conflict.txt')) === 'new local content')
  await app.clickMenu('command:transfer')
  await app.waitFor(exists('[data-testid="conflict-existing"]'), 10000)
  await app.mouseClickButton(DIALOG, 'Keep both')
  const keptBoth = await app.waitFor(`${jobStatus('conflict (1).txt')} === 'completed'`, 15000)
  record(
    'UI conflict: Keep both saves a numbered copy beside the original',
    { keptBoth },
    keptBoth && (await app.waitFor(exists(rowFor('/config/fixture/conflict (1).txt')), 10000)) && (await server.exec("cat '/config/fixture/conflict (1).txt'")) === 'new local content'
  )

  // Several items at once, including a folder, chosen with Cmd-click.
  await mkdir(join(fixture, 'project', 'src', 'deep'), { recursive: true })
  await mkdir(join(fixture, 'project', 'empty'))
  await writeFile(join(fixture, 'project', 'README.md'), 'read me')
  await writeFile(join(fixture, 'project', 'src', 'main.ts'), randomBytes(300_000))
  await writeFile(join(fixture, 'project', 'src', 'deep', 'naïve 文件.txt'), 'unicode')
  await writeFile(join(fixture, 'notes.txt'), 'notes')
  await writeFile(join(fixture, 'data.bin'), randomBytes(2_000_000))
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'project'))
  await selectRow(join(fixture, 'notes.txt'), META)
  await selectRow(join(fixture, 'data.bin'), META)
  record(
    'multi-select: Cmd-click adds rows, and the footer counts them',
    await app.js(localFooter),
    (await app.waitFor(`${localFooter}.startsWith('3 selected')`)) && (await app.js(`document.querySelectorAll(${q(`${LOCAL} [role="row"][aria-selected="true"]`)}).length`)) === 3
  )
  const multiBox = await app.js(box(UPLOAD_BUTTON))
  await app.mouseClick(multiBox.x + multiBox.w / 2, multiBox.y + multiBox.h / 2)
  const treeNames = ['project/README.md', 'project/src/main.ts', 'project/src/deep/naïve 文件.txt', 'notes.txt', 'data.bin']
  const treeDone = await app.waitFor(allDone(treeNames), 30000)
  const treeMatches = JSON.stringify(await serverTree('/config/fixture/project')) === JSON.stringify(await localTree(join(fixture, 'project')))
  record(
    'UI queue: two files and a folder upload as one job per file; the server tree matches, empty folder included',
    { treeDone, treeMatches, remoteShowsProject: await app.js(exists(rowFor('/config/fixture/project'))) },
    treeDone && treeMatches && (await app.waitFor(exists(rowFor('/config/fixture/project')), 10000))
  )

  // Several conflicts: one dialog, and Skip sends only what is new.
  await writeFile(join(fixture, 'fresh.txt'), 'fresh')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'data.bin'))
  await selectRow(join(fixture, 'fresh.txt'), META)
  await selectRow(join(fixture, 'notes.txt'), META)
  await app.clickMenu('command:transfer')
  const multiConflict = await app.waitFor(`${textOf(DIALOG)}.includes('2 items already exist')`, 10000)
  await app.screenshot('7-queue-conflicts')
  const names = await app.js(textOf('[data-testid="conflict-names"]'))
  await app.mouseClickButton(DIALOG, 'Skip')
  const skippedDone = await app.waitFor(`${jobStatus('fresh.txt')} === 'completed' && ${textOf('[data-testid="transfer-notice"]')}.includes('Skipped 2 items')`, 15000)
  record(
    'UI conflict: several existing names share one dialog, and Skip transfers only the new item',
    { multiConflict, names, notice: await app.js(textOf('[data-testid="transfer-notice"]')) },
    multiConflict && names.includes('data.bin') && names.includes('notes.txt') && skippedDone && (await server.exec('cat /config/fixture/notes.txt')) === 'notes'
  )
  await app.mouseClickButton('[data-testid="transfer-notice"]', 'Dismiss')

  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:select-all')
  const allCount = await app.js(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length`)
  const selectAllWorks = await app.waitFor(`${localFooter}.startsWith(${q(`${allCount} selected`)})`)
  // A file to end the range on, now that a download no longer lands in this folder.
  await writeFile(join(fixture, 'from-server.bin'), 'a local copy to select')
  await app.clickMenu('command:refresh')
  await app.waitFor(exists(rowFor(join(fixture, 'from-server.bin'))), 10000)
  // In display order: data.bin, file2.txt, file10.txt, fresh.txt, from-server.bin.
  await selectRow(join(fixture, 'data.bin'))
  await selectRow(join(fixture, 'from-server.bin'), SHIFT)
  record(
    'multi-select: Edit › Select All selects every row; Shift-click selects a range',
    { selectAllWorks, range: await app.js(localFooter) },
    selectAllWorks && (await app.js(`${localFooter}.startsWith('5 selected')`))
  )

  // The limit: four large files, three at a time; cancel the queued one, then all.
  for (const name of ['q1.bin', 'q2.bin', 'q3.bin', 'q4.bin']) await makeZeros(join(fixture, name), 512)
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'q1.bin'))
  await selectRow(join(fixture, 'q4.bin'), SHIFT)
  await app.clickMenu('command:transfer')
  const limited = await app.waitFor(
    `${jobsWith('running')} === 3 && ${jobStatus('q4.bin')} === 'queued' && Number(document.querySelector(${q(`${jobRow('q1.bin')} [role="progressbar"]`)})?.getAttribute('aria-valuenow')) > 0`,
    15000
  )
  await app.screenshot('8-queue-running')
  const summary = await app.js(textOf('[data-testid="transfer-summary"]'))
  const q1Detail = await app.js(textOf(`${jobRow('q1.bin')} [data-testid="job-detail"]`))
  record(
    'UI queue: at most three transfers run at once; the rest wait as Queued, with progress and speed shown',
    { limited, summary, q1Detail },
    limited && summary.startsWith('3 running · 1 queued') && summary.includes('/s') && q1Detail.includes(' of ')
  )
  await app.mouseClickButton(jobRow('q4.bin'), 'Cancel')
  const queuedCancelled = await app.waitFor(`${jobStatus('q4.bin')} === 'cancelled' && ${jobsWith('running')} === 3`)
  await app.mouseClickButton(PANEL, 'Cancel all')
  const allCancelled = await app.waitFor(['q1.bin', 'q2.bin', 'q3.bin'].map((name) => `${jobStatus(name)} === 'cancelled'`).join(' && '), 15000)
  const leftOnServer = (await server.exec('ls -A /config/fixture')).split('\n').filter((name) => name.includes('q') && name.includes('.bin'))
  record(
    'UI queue: cancelling a queued job never starts it; Cancel all stops the rest; nothing is left on the server',
    { queuedCancelled, allCancelled, leftOnServer },
    queuedCancelled && allCancelled && leftOnServer.length === 0
  )
  const clickFilter = async (filter) => {
    const r = await app.js(box(`${PANEL} button[data-filter="${filter}"]`))
    await app.mouseClick(r.x + r.w / 2, r.y + r.h / 2)
  }
  await clickFilter('failed')
  await app.waitFor(`document.querySelector(${q(`${PANEL} button[data-filter="failed"]`)})?.getAttribute('aria-pressed') === 'true'`)
  const failedFilter = await app.js(`[...document.querySelectorAll(${q(`${PANEL} li[data-status]`)})].map((li) => li.dataset.status)`)
  await clickFilter('all')
  record('UI queue: the Failed filter lists failed and cancelled jobs only', failedFilter, failedFilter.length === 4 && failedFilter.every((status) => status === 'cancelled'))

  // A dropped connection fails the batch; Retry failed finishes it after reconnecting.
  for (const name of ['r1.bin', 'r2.bin', 'r3.bin']) await makeZeros(join(fixture, name), 384)
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'r1.bin'))
  await selectRow(join(fixture, 'r3.bin'), SHIFT)
  await app.clickMenu('command:transfer')
  await app.waitFor(`Number(document.querySelector(${q(`${jobRow('r1.bin')} [role="progressbar"]`)})?.getAttribute('aria-valuenow')) > 0`, 15000)
  await server.killSessions()
  const batchFailed = await app.waitFor(['r1.bin', 'r2.bin', 'r3.bin'].map((name) => `${jobStatus(name)} === 'failed'`).join(' && '), 15000)
  await app.screenshot('9-queue-failed')
  const failureReason = await app.js(textOf(`${jobRow('r2.bin')} [data-testid="job-detail"]`))
  await app.mouseClickButton(PANEL, 'Retry failed')
  const needsReconnect = await app.waitFor(`${textOf('[data-testid="transfer-refusal"]')}.includes('Connect to 127.0.0.1 again to retry')`)
  record('UI retry: a dropped connection fails running and queued jobs, and Retry asks to reconnect first', { batchFailed, failureReason, needsReconnect }, batchFailed && /connection lost/i.test(failureReason) && needsReconnect)

  await app.waitFor(exists(profileRow('Smoke key')), 10000)
  await app.js(`document.querySelector(${q(profileRow('Smoke key'))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000)
  await app.mouseClickButton(PANEL, 'Retry failed')
  const retried = await app.waitFor(allDone(['r1.bin', 'r2.bin', 'r3.bin']), 90000)
  const retriedSizes = await server.exec("stat -c '%s' /config/fixture/r1.bin /config/fixture/r2.bin /config/fixture/r3.bin")
  const partialsAfterRetry = (await server.exec('ls -A /config/fixture')).split('\n').filter((name) => name.includes('fly-part'))
  record(
    'UI retry: after reconnecting, Retry failed completes every job on the new connection and removes the partial files the drop left',
    { retried, retriedSizes, partialsAfterRetry },
    retried && retriedSizes === ['402653184', '402653184', '402653184'].join('\n') && partialsAfterRetry.length === 0 &&
      (await server.exec('sha256sum /config/fixture/r2.bin')).split(' ')[0] === (await run('shasum', ['-a', '256', join(fixture, 'r2.bin')])).stdout.split(' ')[0]
  )

  // Disconnecting with transfers running asks first.
  await app.doubleClick(rowFor('/config/fixture'))
  await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  await app.mouseClickButton(PANEL, 'Clear finished')
  await selectRow(join(fixture, 'q1.bin'))
  await app.clickMenu('command:transfer')
  await app.waitFor(`${jobStatus('q1.bin')} === 'running'`, 10000)
  await app.mouseClickButton(REMOTE, 'Disconnect')
  const asked = await app.waitFor(`${textOf(DIALOG)}.includes('Disconnect and cancel transfers?')`)
  await app.mouseClickButton(DIALOG, 'Cancel')
  const stillConnected = (await app.js(`${pathOf(REMOTE)} === '/config/fixture'`)) && (await app.js(`${jobStatus('q1.bin')} === 'running'`))
  await app.mouseClickButton(REMOTE, 'Disconnect')
  await app.waitFor(exists(DIALOG))
  await app.mouseClickButton(DIALOG, 'Disconnect')
  const cancelledByDisconnect = await app.waitFor(`${jobStatus('q1.bin')} === 'cancelled' && ${exists(profileRow('Smoke key'))}`, 10000)
  const partialsAfterDisconnect = (await server.exec('ls -A /config/fixture')).split('\n').filter((name) => name.includes('fly-part'))
  record(
    'UI queue: disconnecting with a transfer running asks first; confirming cancels it and removes its partial file',
    { asked, stillConnected, cancelledByDisconnect, partialsAfterDisconnect },
    asked && stillConnected && cancelledByDisconnect && partialsAfterDisconnect.length === 0
  )

  await app.mouseClickButton(PANEL, 'Clear finished')
  record('UI queue: Clear finished empties the list, and the panel hides when there is nothing to show', '', await app.waitFor(`!${exists(PANEL)}`))

  await app.js(`document.querySelector(${q(profileRow('Smoke key'))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000)
  await app.doubleClick(rowFor('/config/fixture'))
  await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  for (const name of ['q1.bin', 'q2.bin', 'q3.bin', 'q4.bin', 'r1.bin', 'r2.bin', 'r3.bin']) await rm(join(fixture, name))
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')

  // ------------------------------------------------------------ M8: file operations ---

  const NAME_INPUT = 'input[name="item-name"]'
  const TRASH = join(scratch, 'trash')
  const nameProblemText = textOf('[data-testid="name-problem"]')
  const selectedIn = (scope) => `[...document.querySelectorAll(${q(`${scope} [role="row"][aria-selected="true"]`)})].map((row) => row.dataset.path)`
  const inputSelection = `(() => { const i = document.querySelector(${q(NAME_INPUT)}); return i ? i.value.slice(i.selectionStart, i.selectionEnd) : null })()`
  const clickBox = async (selector) => {
    const r = await app.js(box(selector))
    await app.mouseClick(r.x + r.w / 2, r.y + r.h / 2)
  }

  record(
    'menu: File › New Folder (CmdOrCtrl+Shift+N), Rename… (F2), Delete… (no registered accelerator, so text fields keep the key)',
    { newFolder: byId['command:new-folder'], rename: byId['command:rename'], remove: byId['command:delete'] },
    byId['command:new-folder']?.accelerator === 'CmdOrCtrl+Shift+N' && byId['command:rename']?.accelerator === 'F2' &&
      byId['command:delete']?.parent === 'File' && !byId['command:delete']?.accelerator
  )
  await app.evaluate('files: a relative folder is INVALID_INPUT', codeFrom(`window.api.files.createFolder({ side: 'local' }, 'relative', 'x')`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('files: a name with "/" is INVALID_INPUT', codeFrom(`window.api.files.createFolder({ side: 'local' }, ${q(fixture)}, 'a/b')`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('files: an unknown side is INVALID_INPUT', codeFrom(`window.api.files.rename({ side: 'elsewhere' }, ${q(join(fixture, 'file2.txt'))}, 'x')`), (v) => v === 'INVALID_INPUT')
  await app.evaluate('files: deleting the root is NOT_ALLOWED', codeFrom(`window.api.files.delete({ side: 'local' }, ['/'])`), (v) => v === 'NOT_ALLOWED')
  await app.evaluate('files: deleting the home folder is NOT_ALLOWED', codeFrom(`window.api.files.delete({ side: 'local' }, [${q(fixture)}])`), (v) => v === 'NOT_ALLOWED')

  // Local: New Folder from the toolbar, with the real mouse and real typing.
  await app.clickMenu('command:focus-local')
  await clickBox(`${LOCAL} button[aria-label="New folder"]`)
  const nameAsked = await app.waitFor(exists(NAME_INPUT))
  const preselectedNew = await app.js(inputSelection)
  await app.type(NAME_INPUT, 'bad/name')
  const inlineProblem = await app.waitFor(`${nameProblemText}.includes('"/"') && document.querySelector('#name-dialog')?.closest('[role="dialog"]').querySelector('button[type="submit"]').disabled`)
  await app.type(NAME_INPUT, 'Made by smoke')
  await app.mouseClickButton(DIALOG, 'Create')
  const created = await app.waitFor(`!${exists(DIALOG)} && JSON.stringify(${selectedIn(LOCAL)}) === ${q(JSON.stringify([join(fixture, 'Made by smoke')]))}`, 10000)
  record(
    'UI local: New Folder asks for a name, explains a bad one as it is typed, creates the folder and selects it',
    { nameAsked, preselectedNew, inlineProblem, created },
    nameAsked && preselectedNew === 'untitled folder' && inlineProblem && created && (await stat(join(fixture, 'Made by smoke'))).isDirectory()
  )

  // Local: F2 renames, preselecting the name without its extension, and never replaces.
  await writeFile(join(fixture, 'rename-me.txt'), 'rename me')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'rename-me.txt'))
  await app.press('F2', 'F2', 113)
  await app.waitFor(exists(NAME_INPUT))
  const preselectedRename = await app.js(inputSelection)
  await app.type(NAME_INPUT, 'file2.txt')
  await app.mouseClickButton(DIALOG, 'Rename')
  const takenRefused = await app.waitFor(`${nameProblemText}.includes('already exists')`)
  await app.type(NAME_INPUT, 'renamed.txt')
  await app.mouseClickButton(DIALOG, 'Rename')
  const renamed = await app.waitFor(`!${exists(DIALOG)} && ${exists(rowFor(join(fixture, 'renamed.txt')))} && !${exists(rowFor(join(fixture, 'rename-me.txt')))}`, 10000)
  record(
    'UI local: F2 renames in place, preselects the name without its extension, and refuses a taken name',
    { preselectedRename, takenRefused, renamed },
    preselectedRename === 'rename-me' && takenRefused && renamed &&
      (await readFile(join(fixture, 'renamed.txt'), 'utf8')) === 'rename me' && (await readFile(join(fixture, 'file2.txt'), 'utf8')) === 'hello'
  )

  // Local: Delete moves the selection to the Trash after confirming.
  await selectRow(join(fixture, 'Made by smoke'))
  await selectRow(join(fixture, 'renamed.txt'), META)
  await app.press('Delete', 'Delete', 46)
  const trashAsked = await app.waitFor(`${textOf(DIALOG)}.includes('Move 2 items to the Trash?')`)
  const trashFocus = await app.js(`document.activeElement?.textContent ?? ''`)
  await app.screenshot('10-delete-local')
  await app.mouseClickButton(DIALOG, 'Move to Trash')
  const trashedGone = await app.waitFor(`!${exists(DIALOG)} && !${exists(rowFor(join(fixture, 'renamed.txt')))} && !${exists(rowFor(join(fixture, 'Made by smoke')))}`, 10000)
  const inTrash = (await readdir(TRASH).catch(() => [])).sort()
  record(
    'UI local: Delete asks first (Cancel focused), then moves the items to the Trash rather than deleting them',
    { trashAsked, trashFocus, trashedGone, inTrash },
    trashAsked && trashFocus === 'Cancel' && trashedGone && inTrash.some((name) => name.startsWith('Made by smoke-')) && inTrash.some((name) => name.startsWith('renamed.txt-'))
  )

  // Remote: New Folder and Rename from the File menu.
  await app.clickMenu('command:focus-remote')
  await app.clickMenu('command:new-folder')
  await app.waitFor(exists(NAME_INPUT))
  await app.type(NAME_INPUT, 'remote folder')
  await app.mouseClickButton(DIALOG, 'Create')
  const remoteCreated = await app.waitFor(`!${exists(DIALOG)} && JSON.stringify(${selectedIn(REMOTE)}) === ${q(JSON.stringify(['/config/fixture/remote folder']))}`, 10000)
  await app.clickMenu('command:rename')
  await app.waitFor(exists(NAME_INPUT))
  await app.type(NAME_INPUT, 'alpha')
  await app.mouseClickButton(DIALOG, 'Rename')
  const remoteTaken = await app.waitFor(`${nameProblemText}.includes('already exists')`, 10000)
  await app.type(NAME_INPUT, 'renamed remote')
  await app.mouseClickButton(DIALOG, 'Rename')
  const remoteRenamed = await app.waitFor(`!${exists(DIALOG)} && ${exists(rowFor('/config/fixture/renamed remote'))}`, 10000)
  record(
    'UI remote: File › New Folder and File › Rename work on the server, and a taken name is refused',
    { remoteCreated, remoteTaken, remoteRenamed },
    remoteCreated && remoteTaken && remoteRenamed && (await server.exec("stat -c '%F' '/config/fixture/renamed remote'")) === 'directory' &&
      (await server.exec("stat -c '%F' /config/fixture/alpha")) === 'directory'
  )

  // Remote: Cmd+Backspace permanently deletes a mixed selection; a link's target survives.
  await server.exec(
    "mkdir -p /config/fixture/doomed/inner && printf x > /config/fixture/doomed/inner/f.txt && printf y > /config/fixture/doomed-file.txt && ln -s /config/fixture/alpha /config/fixture/doomed-link && printf keep > /config/fixture/alpha/keep.txt && chown -R -h 1000:1000 /config/fixture"
  )
  await app.clickMenu('command:refresh')
  await selectRow('/config/fixture/doomed')
  await selectRow('/config/fixture/doomed-file.txt', META)
  await selectRow('/config/fixture/doomed-link', META)
  await selectRow('/config/fixture/renamed remote', META)
  await app.press('Backspace', 'Backspace', 8, META)
  const permanentAsked = await app.waitFor(`${textOf(DIALOG)}.includes('Permanently delete 4 items?') && ${textOf(DIALOG)}.includes("can't be undone")`)
  await app.screenshot('11-delete-remote')
  await app.mouseClickButton(DIALOG, 'Delete')
  const remoteGone = await app.waitFor(['/config/fixture/doomed', '/config/fixture/doomed-file.txt', '/config/fixture/doomed-link', '/config/fixture/renamed remote'].map((path) => `!${exists(rowFor(path))}`).join(' && '), 15000)
  const stillOnServer = (await server.exec('ls -A /config/fixture')).split('\n').filter((name) => name.startsWith('doomed') || name === 'renamed remote')
  record(
    'UI remote: Cmd+Backspace asks, then permanently deletes files, folders and links; a link to a folder is not followed',
    { permanentAsked, remoteGone, stillOnServer, target: await server.exec('cat /config/fixture/alpha/keep.txt') },
    permanentAsked && remoteGone && stillOnServer.length === 0 && (await server.exec('cat /config/fixture/alpha/keep.txt')) === 'keep'
  )

  // Remote: the home folder can't be deleted, even when selected from its parent.
  await app.clickMenu('command:go-up')
  await app.waitFor(`${pathOf(REMOTE)} === '/config'`)
  await app.clickMenu('command:go-up')
  await app.waitFor(`${pathOf(REMOTE)} === '/'`)
  await selectRow('/config')
  await app.press('Delete', 'Delete', 46)
  await app.waitFor(exists(DIALOG))
  await app.mouseClickButton(DIALOG, 'Delete')
  const homeRefused = await app.waitFor(`${textOf(`${REMOTE} [data-testid="operation-message"]`)}.includes("won't delete")`, 10000)
  record(
    'UI remote: deleting the home folder is refused with an explanation, and nothing is deleted',
    await app.js(textOf(`${REMOTE} [data-testid="operation-message"]`)),
    homeRefused && (await server.exec('ls -A /config/fixture')).includes('alpha')
  )
  await app.mouseClickButton(`${REMOTE} [data-testid="operation-message"]`, 'Dismiss')
  await app.doubleClick(rowFor('/config'))
  await app.waitFor(`${pathOf(REMOTE)} === '/config'`)
  await app.doubleClick(rowFor('/config/fixture'))
  await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  await server.exec('rm -f /config/fixture/alpha/keep.txt')
  await app.clickMenu('command:focus-local')

  // --------------------------------------------------------------- M9: drag and drop ---

  const rowPoint = async (path) => {
    await app.js(`document.querySelector(${q(rowFor(path))}).scrollIntoView({ block: 'center' })`)
    const r = await app.js(box(rowFor(path)))
    return { x: r.x + 40, y: r.y + r.h / 2 }
  }
  const jobCount = `document.querySelectorAll(${q(`${PANEL} li[data-status]`)}).length`
  const dropLabel = (scope) => textOf(`${scope} [data-testid="drop-label"]`)
  /** Closes a pane's search, so later checks see the whole folder again. */
  const clickSearchClose = async (scope) => {
    if (!(await app.js(exists(`${scope} [data-testid="search-close"]`)))) return
    const r = await app.js(box(`${scope} [data-testid="search-close"]`))
    await app.mouseClick(r.x + r.w / 2, r.y + r.h / 2)
    await app.waitFor(`!${exists(`${scope} [data-testid="pane-search"]`)}`, 5000)
  }

  // Local → remote: a Cmd-selected file and folder onto the remote listing (over a file row).
  await writeFile(join(fixture, 'drag-a.txt'), randomBytes(50_000))
  await mkdir(join(fixture, 'drag-dir'))
  await writeFile(join(fixture, 'drag-dir', 'inner.txt'), 'inner')
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'drag-a.txt'))
  await selectRow(join(fixture, 'drag-dir'), META)
  const upDrag = await app.startDrag(await rowPoint(join(fixture, 'drag-a.txt')), await rowPoint('/config/fixture/file2.txt'))
  await upDrag.hover()
  const upHover = {
    label: await app.js(dropLabel(REMOTE)),
    paneActive: await app.js(`document.querySelector(${q(REMOTE)})?.dataset.dropActive === 'true'`),
    types: upDrag.data.items?.map((item) => item.mimeType)
  }
  await app.screenshot('12-drag-to-remote')
  await upDrag.drop()
  const dragUploaded = await app.waitFor(`${jobStatus('drag-a.txt')} === 'completed' && ${jobStatus('drag-dir/inner.txt')} === 'completed'`, 20000)
  record(
    'UI drag: dragging a selection onto the remote pane shows where it will go, then uploads it through the queue',
    { upHover, dragUploaded },
    upHover.label === 'Upload to /config/fixture' && upHover.paneActive && dragUploaded &&
      (await server.exec('cat /config/fixture/drag-dir/inner.txt')) === 'inner' &&
      (await server.exec('sha256sum /config/fixture/drag-a.txt')).split(' ')[0] === sha256(await readFile(join(fixture, 'drag-a.txt'))) &&
      !(await app.js(exists(`${REMOTE} [data-testid="drop-label"]`)))
  )

  // Remote → local: a remote file onto a local folder row lands in that folder.
  await server.exec('printf down > /config/fixture/drag-down.txt && chown 1000:1000 /config/fixture/drag-down.txt')
  await app.clickMenu('command:focus-remote')
  await app.clickMenu('command:refresh')
  await selectRow('/config/fixture/drag-down.txt')
  const downDrag = await app.startDrag(await rowPoint('/config/fixture/drag-down.txt'), await rowPoint(join(fixture, 'alpha')))
  await downDrag.hover()
  const downHover = {
    label: await app.js(dropLabel(LOCAL)),
    rowHighlighted: await app.js(`document.querySelector(${q(rowFor(join(fixture, 'alpha')))})?.dataset.dropTarget === 'true'`)
  }
  await downDrag.drop()
  const dragDownloaded = await app.waitFor(`${jobStatus('drag-down.txt')} === 'completed'`, 20000)
  record(
    'UI drag: dropping a remote file on a local folder row downloads it into that folder',
    { downHover, dragDownloaded },
    downHover.label === `Download to ${join(fixture, 'alpha')}` && downHover.rowHighlighted && dragDownloaded &&
      (await readFile(join(fixture, 'alpha', 'drag-down.txt'), 'utf8').catch(() => '')) === 'down'
  )

  // Within one pane: a folder row takes the drop, and that is a move, not a transfer.
  // The search box narrows the list first, so both rows are on screen together:
  // scrolling one into view would move the other, and the drag would start on the wrong row.
  const twoRowPoints = async (scope, first, second) => {
    const points = await app.js(`(() => {
      const rows = [...document.querySelectorAll(${q(`${scope} [role="row"][data-path]`)})]
      const find = (path) => { const row = rows.find((r) => r.dataset.path === path); if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 } }
      return JSON.stringify({ first: find(${q(first)}), second: find(${q(second)}) })
    })()`)
    return JSON.parse(points)
  }

  const jobsBefore = await app.js(jobCount)
  await app.clickMenu('command:focus-local')
  await mkdir(join(fixture, 'move-target'))
  await writeFile(join(fixture, 'move-me.txt'), 'moving house')
  await app.clickMenu('command:refresh')
  await app.waitFor(exists(rowFor(join(fixture, 'move-me.txt'))), 10000)
  await app.clickMenu('command:find')
  await app.waitFor(exists(`${LOCAL} [data-testid="pane-search"]`))
  await app.type(`${LOCAL} [data-testid="pane-search"]`, 'move-')
  await app.waitFor(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length === 2`, 5000)
  const localPoints = await twoRowPoints(LOCAL, join(fixture, 'move-me.txt'), join(fixture, 'move-target'))
  const moveDrag = await app.startDrag(localPoints.first, localPoints.second)
  await moveDrag.hover()
  const moveHover = {
    label: await app.js(dropLabel(LOCAL)),
    rowHighlighted: await app.js(`document.querySelector(${q(rowFor(join(fixture, 'move-target')))})?.dataset.dropTarget === 'true'`)
  }
  await moveDrag.drop()
  const movedAway = await app.waitFor(`!${exists(rowFor(join(fixture, 'move-me.txt')))}`, 10000)
  record(
    'UI drag: dragging onto a folder in the same pane moves it there, with no transfer queued',
    { moveHover, movedAway, jobsBefore, jobsAfter: await app.js(jobCount), target: await readdir(join(fixture, 'move-target')) },
    moveHover.label === `Move to ${join(fixture, 'move-target')}` && moveHover.rowHighlighted && movedAway &&
      (await readFile(join(fixture, 'move-target', 'move-me.txt'), 'utf8').catch(() => '')) === 'moving house' &&
      (await app.js(jobCount)) === jobsBefore
  )
  await clickSearchClose(LOCAL)

  // A file row is not a destination: only folders take a drop from the same pane.
  await app.clickMenu('command:find')
  await app.waitFor(exists(`${LOCAL} [data-testid="pane-search"]`))
  await app.type(`${LOCAL} [data-testid="pane-search"]`, 'drag-')
  await app.waitFor(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length === 2`, 5000)
  const filePoints = await twoRowPoints(LOCAL, join(fixture, 'drag-a.txt'), join(fixture, 'drag-dir'))
  const ontoFile = await app.startDrag(filePoints.second, filePoints.first)
  await ontoFile.hover()
  const ontoFileHover = {
    label: await app.js(exists(`${LOCAL} [data-testid="drop-label"]`)),
    highlighted: await app.js(`document.querySelector(${q(rowFor(join(fixture, 'drag-a.txt')))})?.dataset.dropTarget === 'true'`)
  }
  await ontoFile.drop()
  await sleep(500)
  record(
    'UI drag: dropping on a file in the same pane does nothing at all',
    { ontoFileHover, stillThere: await stat(join(fixture, 'drag-dir')).then(() => true, () => false) },
    !ontoFileHover.label && !ontoFileHover.highlighted && (await stat(join(fixture, 'drag-dir')).then(() => true, () => false))
  )
  await clickSearchClose(LOCAL)

  // The same move works on the server, over SFTP.
  await app.clickMenu('command:focus-remote')
  await server.exec('mkdir -p /config/fixture/move-target && printf "server side" > /config/fixture/move-on-server.txt && chown -R 1000:1000 /config/fixture/move-target /config/fixture/move-on-server.txt')
  await app.clickMenu('command:refresh')
  await app.waitFor(exists(rowFor('/config/fixture/move-on-server.txt')), 10000)
  await app.clickMenu('command:find')
  await app.waitFor(exists(`${REMOTE} [data-testid="pane-search"]`))
  await app.type(`${REMOTE} [data-testid="pane-search"]`, 'move-')
  await app.waitFor(`document.querySelectorAll(${q(`${REMOTE} [role="row"][data-path]`)}).length === 2`, 5000)
  const remotePoints = await twoRowPoints(REMOTE, '/config/fixture/move-on-server.txt', '/config/fixture/move-target')
  const remoteMove = await app.startDrag(remotePoints.first, remotePoints.second)
  await remoteMove.hover()
  const remoteMoveLabel = await app.js(dropLabel(REMOTE))
  await remoteMove.drop()
  const remoteMovedAway = await app.waitFor(`!${exists(rowFor('/config/fixture/move-on-server.txt'))}`, 10000)
  record(
    'UI drag: the same drag moves a file into a folder on the server',
    { remoteMoveLabel, remoteMovedAway, inTarget: await server.exec('ls -A /config/fixture/move-target') },
    remoteMoveLabel === 'Move to /config/fixture/move-target' && remoteMovedAway &&
      (await server.exec('cat /config/fixture/move-target/move-on-server.txt')) === 'server side'
  )
  await clickSearchClose(REMOTE)
  await app.clickMenu('command:focus-local')

  // Again onto the same place: the conflict dialog asks first.
  await selectRow(join(fixture, 'drag-a.txt'))
  const againDrag = await app.startDrag(await rowPoint(join(fixture, 'drag-a.txt')), await rowPoint('/config/fixture/file2.txt'))
  await againDrag.hover()
  await againDrag.drop()
  const conflictOnDrop = await app.waitFor(`${textOf(DIALOG)}.includes('"drag-a.txt" already exists')`, 10000)
  await app.mouseClickButton(DIALOG, 'Cancel')
  record('UI drag: dropping onto a name that exists asks the conflict question first', '', conflictOnDrop)

  // A file dragged in from outside the app: never navigates, never queues.
  const outsider = join(scratch, 'outsider.html')
  await writeFile(outsider, '<!doctype html><title>outsider</title>')
  const hrefBefore = await app.js('location.href')
  const remoteArea = await app.js(box(REMOTE))
  const external = { items: [], files: [outsider], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await app.send('Input.dispatchDragEvent', { type, x: remoteArea.x + remoteArea.w / 2, y: remoteArea.y + remoteArea.h / 2, data: external })
  }
  await sleep(800)
  record(
    'UI drag: a file dropped from outside the app neither replaces the UI nor starts a transfer',
    { hrefBefore, hrefAfter: await app.js('location.href') },
    (await app.js('location.href')) === hrefBefore && (await app.js(`document.title`)) === 'FileBird' && (await app.js(jobCount)) === jobsBefore
  )

  // Upload chosen from a right-click menu goes through the same queue.
  await writeFile(join(fixture, 'menu-upload.txt'), 'from the menu')
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  await app.waitFor(exists(rowFor(join(fixture, 'menu-upload.txt'))))
  await app.contextMenu(rowFor(join(fixture, 'menu-upload.txt')), 'Upload')
  const menuUploaded = await app.waitFor(`${jobStatus('menu-upload.txt')} === 'completed'`, 20000)
  record(
    'context menu: Upload sends the right-clicked file to the server through the queue',
    { menuUploaded },
    menuUploaded && (await server.exec('cat /config/fixture/menu-upload.txt')) === 'from the menu'
  )

  await app.mouseClickButton(PANEL, 'Clear finished')
  await rm(join(fixture, 'alpha', 'drag-down.txt'))
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')

  if (SHOT_DIR) {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 0, mobile: false })
    await sleep(400)
    await app.screenshot('5-both-panes-min-width')
    await app.send('Emulation.clearDeviceMetricsOverride')
    await sleep(200)
  }

  // ---------------------------------- M5: a frozen remote never blocks the local pane ---

  const localStart = await app.js(pathOf(LOCAL))
  await server.pause()
  let independence
  try {
    await app.doubleClick(rowFor('/config/fixture/alpha'))
    const remoteLoading = await app.waitFor(`${textOf(`${REMOTE} [data-testid="pane-path"]`)} === '/config/fixture' && ${textOf(REMOTE)}.includes('Loading')`)

    // The folder being opened says so once the wait is noticeable, and clicking it
    // again (as an impatient person would) doesn't ask the server again.
    const ROW_LOADING = `${rowFor('/config/fixture/alpha')} [data-testid="row-loading"]`
    const rowLoading = await app.waitFor(
      `document.querySelector(${q(rowFor('/config/fixture/alpha'))})?.getAttribute('aria-busy') === 'true' && ${textOf(ROW_LOADING)}.includes('Opening') && getComputedStyle(document.querySelector(${q(ROW_LOADING)})).opacity === '1'`
    )
    const otherRowsLoading = await app.js(`document.querySelectorAll(${q(`${REMOTE} [data-testid="row-loading"]`)}).length`)
    await app.screenshot('13-remote-folder-opening')
    const listCallsBefore = await app.mainEval('globalThis.__smokeListCalls?.length ?? -1')
    for (let click = 0; click < 3; click++) {
      const point = await rowCentre('/config/fixture/alpha')
      await app.mouseClick(point.x, point.y)
      await sleep(200)
    }
    const repeatListCalls = (await app.mainEval('globalThis.__smokeListCalls?.length ?? -1')) - listCallsBefore
    record(
      'loading: the remote folder being opened shows "Opening…", and clicking it again while it loads sends no new request',
      { rowLoading, otherRowsLoading, listCounter: app.listCounter, listCallsBefore, repeatListCalls },
      rowLoading && otherRowsLoading === 1 && app.listCounter === 'counting' && listCallsBefore > 0 && repeatListCalls === 0
    )
    await app.doubleClick(rowFor(join(fixture, 'alpha')))
    const localOpened = await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`)
    await app.js(`document.querySelector(${q(`${LOCAL} button[aria-label="Back"]`)}).click()`)
    const localBack = await app.waitFor(`${pathOf(LOCAL)} === ${q(localStart)}`)
    await app.js(`document.querySelector(${q(LOCAL)})?.focus()`)
    await app.press('F5', 'F5', 116)
    const stillLoading = await app.js(`${textOf(REMOTE)}.includes('Loading') && ${pathOf(REMOTE)} === '/config/fixture'`)
    independence = { remoteLoading, localOpened, localBack, stillLoading }
  } finally {
    await server.unpause()
  }
  const remoteCaughtUp = await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture/alpha'`, 15000)
  record(
    'loading: the marker goes once the folder has opened',
    await app.js(`document.querySelectorAll('[data-testid="row-loading"], [aria-busy="true"]').length`),
    remoteCaughtUp && (await app.js(`document.querySelectorAll('[data-testid="row-loading"], [aria-busy="true"]').length`)) === 0
  )
  record(
    'independence: while the server is frozen mid-listing, the local pane still opens, goes back and refreshes',
    { ...independence, remoteCaughtUp },
    independence.remoteLoading && independence.localOpened && independence.localBack && independence.stillLoading && remoteCaughtUp
  )

  // ------------------------------------------------ M12: searching a folder ---

  const searchBox = (scope) => `${scope} [data-testid="pane-search"]`
  const rowCount = (scope) => `document.querySelectorAll(${q(`${scope} [role="row"][data-path]`)}).length`
  const paneCount = (scope) => textOf(`${scope} [data-testid="pane-count"]`)

  await app.clickMenu('command:focus-local')
  const localRowsBefore = await app.js(rowCount(LOCAL))
  await app.clickMenu('command:find')
  const searchOpened = await app.waitFor(exists(searchBox(LOCAL)))
  await app.type(searchBox(LOCAL), 'file1')
  const narrowed = await app.waitFor(`${rowCount(LOCAL)} === 1`, 5000)
  record(
    'search: typing narrows the pane to the names that match, and the footer says how many of the folder is showing',
    {
      before: localRowsBefore,
      after: await app.js(rowCount(LOCAL)),
      only: await app.js(`document.querySelector(${q(`${LOCAL} [role="row"][data-path]`)})?.dataset.name ?? document.querySelector(${q(`${LOCAL} [role="row"][data-path]`)})?.dataset.path`),
      footer: await app.js(paneCount(LOCAL)),
      matches: await app.js(textOf(`${LOCAL} [data-testid="search-matches"]`))
    },
    searchOpened && narrowed && localRowsBefore > 1 &&
      (await app.js(`document.querySelector(${q(`${LOCAL} [role="row"][data-path]`)})?.dataset.path`)) === join(fixture, 'file10.txt') &&
      (await app.js(paneCount(LOCAL))) === `1 of ${localRowsBefore} items` &&
      (await app.js(textOf(`${LOCAL} [data-testid="search-matches"]`))) === '1 match'
  )

  // Enter hands the keyboard back to the list, with the first match selected.
  await app.press('Enter', 'Enter', 13)
  const selectedAfterEnter = await app.waitFor(
    `document.querySelector(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})?.dataset.path === ${q(join(fixture, 'file10.txt'))}`,
    5000
  )
  // Escape gives the whole folder back.
  await app.clickMenu('command:find')
  await app.waitFor(exists(searchBox(LOCAL)))
  await app.type(searchBox(LOCAL), 'nothing-matches-this')
  const emptied = await app.waitFor(`${rowCount(LOCAL)} === 0`, 5000)
  const nothingMatches = await app.js(textOf(`${LOCAL} [data-testid="search-matches"]`))
  await app.press('Escape', 'Escape', 27)
  const folderBack = await app.waitFor(`${rowCount(LOCAL)} === ${localRowsBefore} && !${exists(searchBox(LOCAL))}`, 5000)
  record(
    'search: Enter selects the first match, a search with no matches says so, and Escape gives the folder back',
    { selectedAfterEnter, emptied, nothingMatches, folderBack },
    selectedAfterEnter && emptied && nothingMatches === 'nothing matches' && folderBack
  )

  // The remote pane searches its own folder, and the two don't interfere.
  await app.clickMenu('command:focus-remote')
  // Earlier checks may have left this pane deep in the tree, in a folder with nothing in it.
  for (let up = 0; up < 3 && (await app.js(pathOf(REMOTE))) !== '/config/fixture'; up += 1) {
    await app.clickMenu('command:go-up')
    await sleep(500)
  }
  await app.waitFor(`${rowCount(REMOTE)} > 0`, 10000)
  const remoteRowsBefore = await app.js(rowCount(REMOTE))
  await app.clickMenu('command:find')
  await app.waitFor(exists(searchBox(REMOTE)))
  await app.type(searchBox(REMOTE), 'alpha')
  const remoteNarrowed = await app.waitFor(`${rowCount(REMOTE)} === 2`, 5000)
  record(
    'search: the remote pane searches its own folder, and the local pane is untouched',
    {
      remoteBefore: remoteRowsBefore,
      remoteAfter: await app.js(rowCount(REMOTE)),
      localStill: await app.js(rowCount(LOCAL)),
      localHasNoBox: !(await app.js(exists(searchBox(LOCAL))))
    },
    remoteNarrowed && (await app.js(rowCount(LOCAL))) === localRowsBefore && !(await app.js(exists(searchBox(LOCAL))))
  )

  // Opening a folder starts fresh: a search left behind would hide things silently.
  await app.contextMenu(rowFor('/config/fixture/alpha'), 'Open')
  const openedAlpha = await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture/alpha'`, 10000)
  const searchClearedOnOpen = await app.waitFor(`document.querySelector(${q(searchBox(REMOTE))})?.value === ''`, 5000)
  await app.clickMenu('command:go-up')
  await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture'`, 10000)
  record(
    'search: opening another folder empties the search, so nothing stays hidden, and the box stays ready',
    { openedAlpha, searchClearedOnOpen, rowsBack: await app.js(rowCount(REMOTE)) },
    openedAlpha && searchClearedOnOpen && (await app.js(rowCount(REMOTE))) === remoteRowsBefore
  )

  // ------------------------------------------------- M11: terminals in both panes ---

  const terminalText = (scope) => `(document.querySelector(${q(`${scope} .xterm-rows`)})?.innerText ?? '')`
  const tab = (scope, name) => `${scope} [data-testid="tab-${name}"]`
  const openTerminal = async (scope) => {
    const r = await app.js(box(tab(scope, 'terminal')))
    await app.mouseClick(r.x + r.w / 2, r.y + r.h / 2)
    return app.waitFor(`!!document.querySelector(${q(`${scope} .xterm-rows`)})`, 10000)
  }

  // The local pane: a real shell on this computer, started in the pane's folder.
  await app.clickMenu('command:focus-local')
  const localTerminalShown = await openTerminal(LOCAL)
  await app.waitFor(`${terminalText(LOCAL)}.trim().length > 0`, 10000)
  await app.typeInTerminal(LOCAL, 'echo FLY-LOCAL-$((6*7)); pwd')
  const localRan = await app.waitFor(`${terminalText(LOCAL)}.includes('FLY-LOCAL-42')`, 15000)
  const localInFolder = await app.waitFor(`${terminalText(LOCAL)}.includes(${q(fixture)})`, 5000)
  record(
    'terminal: the local pane runs a real shell, starting in the folder it is showing',
    { localTerminalShown, localRan, localInFolder },
    localTerminalShown && localRan && localInFolder
  )

  // Full-screen programs need a real terminal; a plain pipe would say "not a tty".
  await app.typeInTerminal(LOCAL, 'tty; echo TERM-IS-$TERM; echo SIZE-$(tput cols)')
  const isRealTty = await app.waitFor(`${terminalText(LOCAL)}.includes('TERM-IS-xterm-256color')`, 10000)
  record(
    'terminal: it is a real terminal, not a pipe (tty, $TERM and a width)',
    await app.js(`${terminalText(LOCAL)}.split(String.fromCharCode(10)).filter((line) => line.includes('/dev/tty') || line.includes('TERM-IS-') || line.includes('SIZE-')).join(' | ')`),
    isRealTty && (await app.js(`${terminalText(LOCAL)}.includes('/dev/tty')`)) && (await app.js(`${terminalText(LOCAL)}.split('SIZE-')[1]?.trim().charCodeAt(0) >= 49`))
  )

  // While a terminal has focus, the menu's file commands hand their keys over.
  const suppressed = JSON.parse(
    await app.mainEval(`JSON.stringify((() => {
      const menu = process.mainModule.require('electron').Menu.getApplicationMenu()
      const ids = ['refresh', 'select-all', 'go-back', 'go-up', 'transfer', 'new-folder', 'rename', 'delete']
      return { files: ids.map((id) => menu.getMenuItemById('command:' + id)?.enabled), terminal: menu.getMenuItemById('command:toggle-terminal')?.enabled }
    })())`)
  )
  record(
    'terminal: while it has focus, keys that act on files are disabled, and Files / Terminal is not',
    suppressed,
    suppressed.files.every((enabled) => enabled === false) && suppressed.terminal === true
  )

  // Back to the files, and the menu's keys come back with it.
  await app.clickMenu('command:toggle-terminal')
  const backToFiles = await app.waitFor(`document.querySelector(${q(tab(LOCAL, 'files'))})?.getAttribute('aria-selected') === 'true'`)
  await sleep(300)
  const restored = JSON.parse(
    await app.mainEval(`JSON.stringify(['refresh', 'delete'].map((id) => process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById('command:' + id)?.enabled))`)
  )
  await app.clickMenu('command:toggle-terminal')
  const keptScrollback = await app.waitFor(`${terminalText(LOCAL)}.includes('FLY-LOCAL-42')`, 5000)
  record(
    'terminal: Files / Terminal switches back and forth, keeping the session, and restores the file keys',
    { backToFiles, restored, keptScrollback },
    backToFiles && restored.every((enabled) => enabled === true) && keptScrollback
  )

  // The remote pane: a shell on the server, over the connection already open.
  await app.clickMenu('command:focus-remote')
  const remoteTerminalShown = await openTerminal(REMOTE)
  await app.waitFor(`${terminalText(REMOTE)}.trim().length > 0`, 15000)
  const remoteFolder = await app.js(pathOf(REMOTE))
  await app.typeInTerminal(REMOTE, 'echo FLY-REMOTE-$(hostname); pwd')
  const remoteRan = await app.waitFor(`${terminalText(REMOTE)}.includes('FLY-REMOTE-')`, 20000)
  const remoteInFolder = await app.waitFor(`${terminalText(REMOTE)}.includes(${q(remoteFolder)})`, 10000)
  record(
    'terminal: the remote pane runs a shell on the server, in the folder it is showing',
    { remoteFolder, remoteTerminalShown, remoteRan, remoteInFolder },
    remoteTerminalShown && remoteRan && remoteInFolder && remoteFolder.length > 0
  )

  // The same connection carries transfers while a terminal is open.
  await server.exec('printf beside > /config/fixture/beside-terminal.txt && chown 1000:1000 /config/fixture/beside-terminal.txt')
  await app.typeInTerminal(REMOTE, 'echo STILL-HERE')
  await app.clickMenu('command:toggle-terminal')
  await app.waitFor(`document.querySelector(${q(tab(REMOTE, 'files'))})?.getAttribute('aria-selected') === 'true'`)
  // The pane may be deeper in the tree from an earlier check; the file is in /config/fixture.
  for (let up = 0; up < 3 && (await app.js(pathOf(REMOTE))) !== '/config/fixture'; up += 1) {
    await app.clickMenu('command:go-up')
    await sleep(400)
  }
  await app.clickMenu('command:refresh')
  const besideListed = await app.waitFor(exists(rowFor('/config/fixture/beside-terminal.txt')), 10000)
  await selectRow('/config/fixture/beside-terminal.txt')
  const downloadBox = await app.js(box(`${REMOTE} [data-testid="download-button"]`))
  await app.mouseClick(downloadBox.x + downloadBox.w / 2, downloadBox.y + downloadBox.h / 2)
  const downloadedBeside = await app.waitFor(`${jobStatus('beside-terminal.txt')} === 'completed'`, 20000)
  record(
    'terminal: a transfer still works on a connection that is also running a terminal',
    { besideListed, downloadedBeside },
    besideListed && downloadedBeside && (await readFile(join(scratch, 'downloads', 'beside-terminal.txt'), 'utf8').catch(() => '')) === 'beside'
  )

  await app.js(`document.querySelector(${q(rowFor(join(fixture, 'file2.txt')))}).click()`)
  const localBeforeDisconnect = await app.js(`JSON.stringify({ path: ${pathOf(LOCAL)}, selected: document.querySelector(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})?.dataset.path })`)
  await app.click(REMOTE, 'Disconnect')
  await app.waitFor(exists(profileRow('Smoke key')))
  const localAfterDisconnect = await app.js(`JSON.stringify({ path: ${pathOf(LOCAL)}, selected: document.querySelector(${q(`${LOCAL} [role="row"][aria-selected="true"]`)})?.dataset.path })`)
  record('independence: disconnecting leaves the local path and selection untouched', localAfterDisconnect, localAfterDisconnect === localBeforeDisconnect)

  record(
    'terminal: disconnecting closes the remote terminal, and the local one carries on',
    {
      remoteTabs: await app.js(`document.querySelectorAll(${q(tab(REMOTE, 'terminal'))}).length`),
      localStillThere: await app.js(`${terminalText(LOCAL)}.includes('FLY-LOCAL-42')`)
    },
    (await app.js(`document.querySelectorAll(${q(tab(REMOTE, 'terminal'))}).length`)) === 0 &&
      (await app.js(`${terminalText(LOCAL)}.includes('FLY-LOCAL-42')`))
  )

  // ----------------------------------------------------- password, not remembered ---

  await app.click(PANE, 'New connection')
  await app.waitFor(exists(NEW_FORM))
  await app.type(`${NEW_FORM} input[name="name"]`, 'Smoke password')
  await app.type(`${NEW_FORM} input[name="host"]`, server.host)
  await app.type(`${NEW_FORM} input[name="port"]`, String(server.port))
  await app.type(`${NEW_FORM} input[name="username"]`, server.username)
  await app.js(`document.querySelector(${q(`${NEW_FORM} input[name="auth"][value="password"]`)}).click()`)
  await app.click(NEW_FORM, 'Save')
  await app.waitFor(exists(profileRow('Smoke password')))
  await app.click(profileRow('Smoke password'), 'Connect')
  record('UI password: a password is asked for when not saved', '', await app.waitFor(`${textOf(DIALOG)}.includes('Password for fly@127.0.0.1')`, 10000))
  await app.type('input[name="secret"]', 'definitely-wrong')
  await app.click(DIALOG, 'Connect')
  record('UI password: a wrong password is asked for again, marked rejected', await app.js(alertIn(DIALOG)), await app.waitFor(`${alertIn(DIALOG)}.includes('not accepted')`, 15000))
  await app.type('input[name="secret"]', server.password)
  await app.click(DIALOG, 'Connect')
  record('UI password: the right password connects', '', await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000))
  await app.click(REMOTE, 'Disconnect')
  await app.waitFor(exists(profileRow('Smoke password')))
  const passwordId = (await profileIds()).find((id) => id !== keyProfileId)
  await app.click(profileRow('Smoke password'), 'Connect')
  const askedAgain = await app.waitFor(exists('input[name="secret"]'), 10000)
  record('UI password: not ticking Remember means it is asked again, and nothing is stored', '', askedAgain && !(await keychainHas(`connection/${passwordId}/password`)))
  // Remember it this time, then forget it from the list.
  await app.type('input[name="secret"]', server.password)
  await app.js(`document.querySelector('input[name="remember"]').click()`)
  await app.click(DIALOG, 'Connect')
  await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000)
  await app.click(REMOTE, 'Disconnect')
  const passwordAccount = `connection/${passwordId}/password`
  const passwordSaved = await app.waitFor(`${textOf(`${profileRow('Smoke password')} [data-testid="saved-secret"]`)} === 'password saved'`)
  record('UI password: a remembered password is saved in the Keychain and shown as saved', '', passwordSaved && (await keychainHas(passwordAccount)))
  await app.click(profileRow('Smoke password'), 'Forget password')
  const badgeGone = await app.waitFor(`!${exists(`${profileRow('Smoke password')} [data-testid="saved-secret"]`)}`)
  record('UI password: Forget removes the saved password from the Keychain', '', badgeGone && !(await keychainHas(passwordAccount)))

  // ------------------------------------------------------------- SSH config import ---

  await app.click(PANE, 'Import from SSH config')
  const consentShown = await app.waitFor(exists('[data-testid="import-consent"]'), 10000)
  await app.screenshot('3-import-consent')
  let markerBefore = true
  try { await stat(marker) } catch { markerBefore = false }
  record('UI import: Match exec needs consent, and nothing has run yet', await app.js(textOf('[data-testid="import-consent"]')), consentShown && !markerBefore)

  await app.click(DIALOG, 'Run them and continue')
  const candidatesShown = await app.waitFor(exists('[data-import-alias="smoke-imported"]'), 15000)
  let markerAfter = false
  try { await stat(marker); markerAfter = true } catch {}
  await app.screenshot('4-import-candidates')
  const jumpedText = await app.js(textOf('[data-import-alias="smoke-jumped"]'))
  record(
    'UI import: after consent, hosts are listed with their key and warnings',
    { imported: await app.js(textOf('[data-import-alias="smoke-imported"]')), jumpedText, markerAfter },
    candidatesShown && markerAfter && (await app.js(textOf('[data-import-alias="smoke-imported"]'))).includes(keyPath) && jumpedText.includes('jump host')
  )
  record(
    'UI import: a host with warnings starts unticked',
    '',
    (await app.js(`document.querySelector('[data-import-alias="smoke-jumped"] input').checked`)) === false &&
      (await app.js(`document.querySelector('[data-import-alias="smoke-imported"] input').checked`)) === true
  )
  await app.click(DIALOG, 'Import 1')
  const importedListed = await app.waitFor(`${exists(profileRow('smoke-imported'))} && ${textOf(profileRow('smoke-imported'))}.includes('from SSH config')`, 10000)
  record('UI import: the chosen host becomes a saved connection', await app.js(textOf(`${PANE} [role="status"]`)), importedListed && !(await app.js(exists(profileRow('smoke-jumped')))))

  await app.click(profileRow('smoke-imported'), 'Connect')
  await app.waitFor(exists('input[name="secret"]'), 10000)
  await app.type('input[name="secret"]', TEST_PASSPHRASE)
  await app.click(DIALOG, 'Connect')
  record('UI import: the imported host connects with its key', '', await app.waitFor(`${pathOf(REMOTE)} === '/config'`, 15000))
  await app.click(REMOTE, 'Disconnect')
  await app.waitFor(exists(profileRow('smoke-imported')))

  // ---------------------------------------------------------- identity change ---

  await server.rotateHostKeys()
  const rotated = await server.keyscanFingerprints()
  await app.click(profileRow('Smoke key'), 'Connect')
  const warned = await app.waitFor(exists('[data-testid="host-key-offered"]'), 15000)
  const saved = await app.js(textOf('[data-testid="host-key-saved"]'))
  const offered = await app.js(textOf('[data-testid="host-key-offered"]'))
  record('UI host key: a changed key is refused with both fingerprints', { saved, offered }, warned && saved === shownFingerprint && rotated.includes(offered) && saved !== offered)
  await app.click(DIALOG, 'I know why it changed…')
  await app.click(DIALOG, 'Forget saved key')
  await app.waitFor(`${textOf(`${PANE} [role="status"]`)}.includes('saved key was removed')`)
  await app.click(profileRow('Smoke key'), 'Connect')
  const reprompted = await app.waitFor(exists('[data-testid="host-key-fingerprint"]'), 15000)
  record('UI host key: after forgetting, the new key is offered for review', '', reprompted && (await app.js(textOf('[data-testid="host-key-fingerprint"]'))) === offered)
  await app.click(DIALOG, 'Cancel')

  // ------------------------------------------------------------------- deleting ---

  for (const name of ['Smoke key', 'Smoke password', 'smoke-imported']) {
    await app.waitFor(exists(profileRow(name)))
    await app.click(profileRow(name), 'Delete')
    await app.waitFor(exists(DIALOG))
    await app.click(DIALOG, 'Delete')
    await app.waitFor(`!${exists(profileRow(name))}`)
  }
  record('UI delete: connections are removed after confirmation', '', await app.waitFor(`${textOf(PANE)}.includes('No saved connections yet')`))
  record('delete: the saved passphrase is removed from the Keychain', passphraseAccount, !(await keychainHas(passphraseAccount)))

  // --------------------------------------- M10: asking before quitting with transfers ---

  // The native dialog can't be clicked over CDP, so the main process's dialog is
  // replaced through its inspector with one that records the question and answers.
  await app.mainEval(`(() => {
    const { dialog } = process.mainModule.require('electron')
    globalThis.__questions = []
    globalThis.__answer = 0
    dialog.showMessageBox = async (...args) => {
      globalThis.__questions.push(args.at(-1).message)
      return { response: globalThis.__answer, checkboxChecked: false }
    }
    return true
  })()`)
  const probe = await app.js(`window.api.connections.connectUnsaved(${JSON.stringify({ name: 'quit test', host: server.host, port: server.port, username: server.username, auth: { type: 'password' } })}, { value: ${q(server.password)}, remember: false })`)
  const live = probe?.status === 'host-key-unknown' ? await app.js(`window.api.sftp.trustHostKeyAndConnect(${q(probe.token)})`) : probe
  await makeZeros(join(fixture, 'quit-test.bin'), 1024)
  await app.js(`window.api.transfers.start(${JSON.stringify({ connectionId: live?.connection?.id, direction: 'upload', sourcePaths: [join(fixture, 'quit-test.bin')], destinationDirectory: '/config', onConflict: 'replace' })})`)
  await app.waitFor(`window.api.transfers.list().then((jobs) => jobs.some((job) => job.status === 'running'))`, 10000)

  await app.mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close()`)
  await sleep(800)
  const closeKept = await app.js(`window.api.transfers.list().then((jobs) => jobs.some((job) => job.status === 'running'))`).catch(() => false)
  await app.mainEval(`process.mainModule.require('electron').app.quit()`)
  await sleep(800)
  const quitKept = await app.js(`window.api.transfers.list().then((jobs) => jobs.some((job) => job.status === 'running'))`).catch(() => false)
  const questions = await app.mainEval('JSON.stringify(globalThis.__questions)')
  record(
    'quit: with a transfer running, closing the window and quitting both ask first; Cancel keeps the app and the transfer',
    { questions, closeKept, quitKept },
    questions === JSON.stringify(['Close the window and cancel 1 transfer?', 'Quit FileBird and cancel 1 transfer?']) && closeKept && quitKept
  )

  await app.mainEval('globalThis.__answer = 1')
  const quitStarted = Date.now()
  const quitConfirmed = await app.quitFromMenu(8000)
  const partials = (await server.exec('ls -A /config')).split('\n').filter((name) => name.includes('quit-test'))
  record(
    'quit: confirming cancels the transfer, removes its partial file and quits promptly',
    { quitConfirmed, seconds: (Date.now() - quitStarted) / 1000, partials },
    quitConfirmed && partials.length === 0
  )
  await rm(join(fixture, 'quit-test.bin'), { force: true })
} catch (err) {
  record('FATAL', err.stack ?? err.message, false)
} finally {
  // Anything a failed run left in the Keychain goes, via the binary that created it.
  if (userData) {
    const ids = await profileIds()
    await deleteKeychainItems(ids.flatMap((id) => [`connection/${id}/password`, `connection/${id}/passphrase`]))
  }
  await app?.close()
  await server?.remove()
  await keys?.remove()
  if (fixture) {
    await chmod(join(fixture, 'locked'), 0o755).catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  }
  for (const dir of [userData, scratch]) if (dir) await rm(dir, { recursive: true, force: true })
}

// Secrets must never reach the log. Checked against output that demonstrably
// covers connections, so an empty log cannot pass it.
if (server) {
  const logText = mainLogs.join('')
  const leaked = [server.password, TEST_PASSPHRASE, 'definitely-wrong', 'not the passphrase'].filter((s) => logText.includes(s))
  record(
    'nothing typed or printed in a terminal appears in the main-process log',
    { terminalMarkers: ['FLY-LOCAL-42', 'FLY-REMOTE-', 'STILL-HERE'].filter((marker) => logText.includes(marker)) },
    logText.includes('"message":"Terminal opened"') &&
      !['FLY-LOCAL-42', 'FLY-REMOTE-', 'STILL-HERE', 'TERM-IS-xterm'].some((marker) => logText.includes(marker))
  )
  record(
    'no password or passphrase appears in the main-process log',
    { logCoversConnections: logText.includes('"message":"Connected"'), leaked: leaked.length },
    logText.includes('"message":"Connected"') && leaked.length === 0
  )
}

// ------------------------------------------------------------------- report ---

for (const [label, value, pass] of results) {
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  [${label}]\n  ${String(value).slice(0, 400)}`)
}

const failed = results.filter(([, , pass]) => !pass)
if (failed.length > 0 || results.length === 0) {
  console.log('\n=== MAIN PROCESS LOG ===')
  console.log(mainLogs.join('').trim().slice(-3000) || '(empty)')
}

const total = results.length
console.log(`\n${total - failed.length}/${total} checks passed` + (failed.length ? `: ${failed.map(([l]) => l).join(', ')}` : ''))
process.exit(failed.length > 0 || total === 0 ? 1 : 0)
