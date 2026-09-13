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
import { dirname, join } from 'node:path'
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
const realTrustStore = join(homedir(), 'Library', 'Application Support', 'fly', 'known-hosts.json')
const realTrustBefore = await readFile(realTrustStore, 'utf8').catch(() => null)

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
    env: { ...inherited, FLY_DEV_HOME: fixture }
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdout.on('data', (d) => mainLogs.push(d.toString()))
  child.stderr.on('data', (d) => mainLogs.push(d.toString()))

  let page
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {}
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('No page target appeared')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
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

  // Focus events fire only in a focused page, and macOS does not always
  // activate an app launched from a background process (the relaunch often
  // isn't, and it can't take focus itself), so have the page act focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const self = {
    send,
    js,
    mainEval,
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
    async mouseClick(x, y, clickCount = 1) {
      for (let c = 1; c <= clickCount; c++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c })
      }
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
    async close() {
      ws.close()
      mainWs.close()
      child.kill('SIGTERM')
      await Promise.race([exited, sleep(5000)])
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
  const rendered = await app.waitFor(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length > 0`)

  // ------------------------------------------------------------- architecture ---

  await app.evaluate('renderer mounted with both panes', `${exists(LOCAL)} && ${exists(PANE)}`, (v) => v === true)
  await app.evaluate(
    'bridge exposes exactly the approved methods',
    `JSON.stringify(Object.fromEntries(Object.entries(window.api).map(([k, v]) => [k, Object.keys(v).sort()]).sort()))`,
    (v) =>
      v ===
      JSON.stringify({
        app: ['onMenuCommand'],
        connections: ['connect', 'connectUnsaved', 'create', 'delete', 'forgetSecret', 'list', 'update'],
        keys: ['inspect', 'pick'],
        local: ['getHomeDirectory', 'listDirectory'],
        sftp: ['disconnect', 'forgetHostKey', 'listDirectory', 'onConnectionClosed', 'trustHostKeyAndConnect'],
        sshConfig: ['import', 'preview'],
        system: ['getVersion'],
        transfers: ['cancel', 'onUpdate', 'start']
      })
  )
  await app.evaluate('node hidden', `[window.require, window.process, window.module].every(v => v === undefined)`, (v) => v === true)
  await app.evaluate('tailwind applied', `getComputedStyle(document.body).backgroundColor`, (v) => v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent')

  // ------------------------------------------------------- local files over IPC ---

  await app.evaluate('getHomeDirectory', `window.api.local.getHomeDirectory()`, (v) => v === fixture)
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

  await app.doubleClick(rowFor(join(fixture, 'alpha')))
  record('UI local: double-click opens a folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))
  await app.js(`document.querySelector(${q(`${LOCAL} button[aria-label="Back"]`)}).click()`)
  record(
    'UI local: Back returns and reselects the folder',
    await app.js(pathOf(LOCAL)),
    await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)} && document.querySelector(${q(`${LOCAL} [aria-selected="true"]`)})?.dataset.path === ${q(join(fixture, 'alpha'))}`)
  )
  await app.js(`document.querySelector(${q(LOCAL)}).focus()`)
  await app.press('Enter', 'Enter', 13)
  record('UI local: Enter opens the selected folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))
  await app.press('Backspace', 'Backspace', 8)
  record('UI local: Backspace goes to the parent folder', await app.js(pathOf(LOCAL)), await app.waitFor(`${pathOf(LOCAL)} === ${q(fixture)}`))
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
      menu.some((i) => i.role === 'editmenu')
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
  await app.js(`document.querySelector(${q(SEPARATOR)}).focus()`)
  for (let i = 0; i < 5; i++) await app.press('ArrowRight', 'ArrowRight', 39)
  const expectedSplit = await app.js(splitValue)
  record('splitter: double-click resets to 50, and → moves it in 2% steps', { afterReset, expectedSplit }, afterReset === 50 && expectedSplit === 60)

  // ------------------------------------------------- M5: active pane ---

  await app.js(`document.querySelector(${q(LOCAL)}).focus()`)
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

  await app.js(`document.querySelector(${q(LOCAL)}).focus()`)
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
  const realTrustAfter = await readFile(realTrustStore, 'utf8').catch(() => null)
  record('storage: the real app data was not touched', '', realTrustAfter === realTrustBefore)

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

  await app.close()
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
  await app.js(`document.querySelector(${q(rowFor(join(fixture, 'alpha')))}).click()`)
  await app.evaluate(
    'footer: each pane shows its own count and selection',
    `JSON.stringify({ local: ${textOf(`${LOCAL} [data-testid="pane-selection"]`)}, remote: ${textOf(`${REMOTE} [data-testid="pane-selection"]`)}, remoteCount: ${textOf(`${REMOTE} [data-testid="pane-count"]`)} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.local === 'alpha · Folder' && d.remote === 'file2.txt · 5 bytes' && d.remoteCount === `${EXPECTED_REMOTE.length} items`
    }
  )

  // ------------------------------------------------------------ M6: transfers ---

  const BAR = '[data-testid="transfer-bar"]'
  const UPLOAD_BUTTON = '[data-testid="upload-button"]'
  const barStatus = `document.querySelector(${q(BAR)})?.dataset.status`
  const barId = `document.querySelector(${q(BAR)})?.dataset.transferId`
  /** Waits for a transfer other than `previousId` to reach `status`. */
  const transferReached = async (status, previousId, timeoutMs = 30000) =>
    app.waitFor(`${barStatus} === ${q(status)} && ${barId} !== ${q(previousId ?? '')}`, timeoutMs)
  const selectRow = async (path) => {
    await app.waitFor(exists(rowFor(path)), 10000)
    await app.js(`document.querySelector(${q(rowFor(path))}).scrollIntoView({ block: 'center' }); document.querySelector(${q(rowFor(path))}).click()`)
  }
  const FAKE_ID = '5b7c1f7e-7a51-4a5f-9a43-3f1d8c2b9e10'

  record('menu: Transfer › Transfer to Other Pane is CmdOrCtrl+T', byId['command:transfer'], byId['command:transfer']?.accelerator === 'CmdOrCtrl+T' && byId['command:transfer']?.parent === 'Transfer')
  await app.evaluate(
    'transfers: a malformed request is INVALID_INPUT',
    codeFrom(`window.api.transfers.start({ connectionId: 'nope', direction: 'upload', sourcePath: '/x', destinationDirectory: '/y', onConflict: 'ask' })`),
    (v) => v === 'INVALID_INPUT'
  )
  await app.evaluate(
    'transfers: a relative local path is INVALID_INPUT',
    codeFrom(`window.api.transfers.start({ connectionId: ${q(FAKE_ID)}, direction: 'download', sourcePath: '/config/fixture/file2.txt', destinationDirectory: 'Downloads', onConflict: 'ask' })`),
    (v) => v === 'INVALID_INPUT'
  )
  await app.evaluate(
    'transfers: an unknown connection is NOT_CONNECTED',
    codeFrom(`window.api.transfers.start({ connectionId: ${q(FAKE_ID)}, direction: 'upload', sourcePath: ${q(join(fixture, 'file2.txt'))}, destinationDirectory: '/config', onConflict: 'ask' })`),
    (v) => v === 'NOT_CONNECTED'
  )
  record('UI transfer: Upload is unavailable while a folder is selected', '', await app.js(`document.querySelector(${q(UPLOAD_BUTTON)})?.disabled === true`))

  // Upload with the toolbar button, using the real mouse.
  const uploadData = randomBytes(8_000_000)
  await writeFile(join(fixture, 'upload-me.bin'), uploadData)
  await app.clickMenu('command:focus-local')
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'upload-me.bin'))
  await app.waitFor(`document.querySelector(${q(UPLOAD_BUTTON)})?.disabled === false`)
  const uploadBox = await app.js(box(UPLOAD_BUTTON))
  await app.mouseClick(uploadBox.x + uploadBox.w / 2, uploadBox.y + uploadBox.h / 2)
  const uploaded = await transferReached('completed', null)
  const uploadHeadline = await app.js(textOf('[data-testid="transfer-headline"]'))
  const uploadedRemoteSha = (await server.exec('sha256sum /config/fixture/upload-me.bin')).split(' ')[0]
  const uploadListed = await app.waitFor(exists(rowFor('/config/fixture/upload-me.bin')), 10000)
  record(
    'UI transfer: Upload sends the selected file intact, and the remote pane shows it',
    { uploaded, uploadHeadline, sameContent: uploadedRemoteSha === sha256(uploadData), uploadListed },
    uploaded && uploadHeadline === 'Uploaded upload-me.bin' && uploadedRemoteSha === sha256(uploadData) && uploadListed
  )
  const firstId = await app.js(barId)

  // Download with the menu command, from the active remote pane.
  await server.exec('head -c 4000000 /dev/urandom > /config/fixture/from-server.bin && chown 1000:1000 /config/fixture/from-server.bin')
  await app.clickMenu('command:focus-remote')
  await app.clickMenu('command:refresh')
  await selectRow('/config/fixture/from-server.bin')
  await app.clickMenu('command:transfer')
  const downloaded = await transferReached('completed', firstId)
  const serverSha = (await server.exec('sha256sum /config/fixture/from-server.bin')).split(' ')[0]
  const localSha = sha256(await readFile(join(fixture, 'from-server.bin')).catch(() => Buffer.alloc(0)))
  const downloadListed = await app.waitFor(exists(rowFor(join(fixture, 'from-server.bin'))), 10000)
  const leftovers = (await readdir(fixture)).filter((name) => name.includes('fly-part'))
  record(
    'UI transfer: Transfer › Transfer to Other Pane downloads from the active pane, intact, and the local pane shows it',
    { downloaded, sameContent: serverSha === localSha, downloadListed, leftovers },
    downloaded && serverSha === localSha && downloadListed && leftovers.length === 0
  )
  const secondId = await app.js(barId)

  // An existing file: asked first, then replaced; then kept both.
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
    serverStill: await server.exec('cat /config/fixture/conflict.txt')
  }
  record(
    'UI conflict: an existing file is not touched until the user chooses; Cancel is focused',
    conflictFacts,
    conflictShown && conflictFacts.focused === 'Cancel' && conflictFacts.existing.includes('3 bytes') && conflictFacts.incoming.includes('17 bytes') && conflictFacts.serverStill === 'old'
  )
  await app.click(DIALOG, 'Replace')
  const replaced = await transferReached('completed', secondId)
  record('UI conflict: Replace overwrites the server copy', await server.exec('cat /config/fixture/conflict.txt'), replaced && (await server.exec('cat /config/fixture/conflict.txt')) === 'new local content')
  const thirdId = await app.js(barId)

  await app.clickMenu('command:transfer')
  await app.waitFor(exists('[data-testid="conflict-existing"]'), 10000)
  await app.click(DIALOG, 'Keep both')
  const keptBoth = await transferReached('completed', thirdId)
  const numberedListed = await app.waitFor(exists(rowFor('/config/fixture/conflict (1).txt')), 10000)
  record(
    'UI conflict: Keep both saves a numbered copy beside the original',
    { keptBoth, numberedListed },
    keptBoth && numberedListed && (await server.exec("cat '/config/fixture/conflict (1).txt'")) === 'new local content' && (await server.exec('cat /config/fixture/conflict.txt')) === 'new local content'
  )
  const fourthId = await app.js(barId)

  // A large upload: progress, a refused second transfer, then Cancel.
  await run('dd', ['if=/dev/zero', `of=${join(fixture, 'big.bin')}`, 'bs=1048576', 'count=768'])
  await app.clickMenu('command:refresh')
  await selectRow(join(fixture, 'big.bin'))
  await app.clickMenu('command:transfer')
  const progressing = await app.waitFor(
    `${barStatus} === 'running' && ${barId} !== ${q(fourthId)} && ${textOf('[data-testid="transfer-detail"]')}.includes(' of ') && ${textOf('[data-testid="transfer-detail"]')}.endsWith('/s') && Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 0`,
    15000
  )
  await app.screenshot('7-transfer-running')
  const runningDetail = await app.js(textOf('[data-testid="transfer-detail"]'))
  record('UI transfer: a running transfer shows progress, amount and speed', runningDetail, progressing)
  record('UI transfer: Upload is unavailable while a transfer runs', '', await app.js(`document.querySelector(${q(UPLOAD_BUTTON)})?.disabled === true`))

  await app.clickMenu('command:focus-remote')
  await selectRow('/config/fixture/file2.txt')
  await app.clickMenu('command:transfer')
  const busyRefused = await app.waitFor(`${textOf('[data-testid="transfer-refusal"]')}.includes('Another transfer is still running') && ${barStatus} === 'running'`, 10000)
  record('UI transfer: a second transfer is refused, and the running one stays in view', await app.js(textOf('[data-testid="transfer-refusal"]')), busyRefused)

  const cancelBox = await app.js(`(() => { const b = [...document.querySelectorAll(${q(`${BAR} button`)})].find((x) => x.textContent === 'Cancel'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await app.mouseClick(cancelBox.x, cancelBox.y)
  const cancelled = await app.waitFor(`${barStatus} === 'cancelled'`, 15000)
  const afterCancel = await server.exec('ls -A /config/fixture')
  record(
    'UI transfer: Cancel stops a large upload and leaves nothing behind on the server',
    { cancelled, afterCancel },
    cancelled && !afterCancel.includes('big.bin')
  )
  await app.click('[data-testid="transfer-refusal"]', 'Dismiss')
  await app.click(BAR, 'Dismiss')
  record('UI transfer: Dismiss clears the finished transfer and the refusal', '', await app.waitFor(`!${exists(BAR)} && !${exists('[data-testid="transfer-refusal"]')}`))
  await rm(join(fixture, 'big.bin'))

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
    await app.doubleClick(rowFor(join(fixture, 'alpha')))
    const localOpened = await app.waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`)
    await app.js(`document.querySelector(${q(`${LOCAL} button[aria-label="Back"]`)}).click()`)
    const localBack = await app.waitFor(`${pathOf(LOCAL)} === ${q(localStart)}`)
    await app.js(`document.querySelector(${q(LOCAL)}).focus()`)
    await app.press('F5', 'F5', 116)
    const stillLoading = await app.js(`${textOf(REMOTE)}.includes('Loading') && ${pathOf(REMOTE)} === '/config/fixture'`)
    independence = { remoteLoading, localOpened, localBack, stillLoading }
  } finally {
    await server.unpause()
  }
  const remoteCaughtUp = await app.waitFor(`${pathOf(REMOTE)} === '/config/fixture/alpha'`, 15000)
  record(
    'independence: while the server is frozen mid-listing, the local pane still opens, goes back and refreshes',
    { ...independence, remoteCaughtUp },
    independence.remoteLoading && independence.localOpened && independence.localBack && independence.stillLoading && remoteCaughtUp
  )

  await app.js(`document.querySelector(${q(rowFor(join(fixture, 'file2.txt')))}).click()`)
  const localBeforeDisconnect = await app.js(`JSON.stringify({ path: ${pathOf(LOCAL)}, selected: document.querySelector(${q(`${LOCAL} [aria-selected="true"]`)})?.dataset.path })`)
  await app.click(REMOTE, 'Disconnect')
  await app.waitFor(exists(profileRow('Smoke key')))
  const localAfterDisconnect = await app.js(`JSON.stringify({ path: ${pathOf(LOCAL)}, selected: document.querySelector(${q(`${LOCAL} [aria-selected="true"]`)})?.dataset.path })`)
  record('independence: disconnecting leaves the local path and selection untouched', localAfterDisconnect, localAfterDisconnect === localBeforeDisconnect)

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
