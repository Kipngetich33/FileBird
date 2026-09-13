// End-to-end smoke test: launches the built app and drives the real renderer
// over CDP with real mouse and keyboard input, so the whole
// preload -> IPC -> main chain is exercised for real.
//
// Local pane: a fixture directory, with the app's HOME pointed at it.
// Remote pane: a real OpenSSH server in a container (needs `colima start fly`).
// The app runs with a throwaway --user-data-dir, so the real trust store is
// never touched.
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startSftpServer } from '../test/support/sftp-container.ts'

const PORT = 9222
const SHOT_DIR = process.env.SMOKE_SCREENSHOT_DIR
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (value) => JSON.stringify(value)

const EXPECTED_ORDER = ['alpha', 'link-to-alpha', 'locked', '.hidden', 'broken-link', 'file2.txt', 'file10.txt']

const LOCAL = '[aria-label="Local files"]'
const REMOTE = '[aria-label="Remote files"]'
const FORM = '[aria-label="Remote connection"]'

const results = []
const record = (label, value, pass) =>
  results.push([label, typeof value === 'string' ? value : JSON.stringify(value), Boolean(pass)])

const mainLogs = []
let child
let server
let fixture
let userData

// A trust store the smoke test must never write to.
const realTrustStore = join(homedir(), 'Library', 'Application Support', 'fly', 'known-hosts.json')
const realTrustBefore = await readFile(realTrustStore, 'utf8').catch(() => null)

try {
  // ---------------------------------------------------------------- fixtures ---

  fixture = await mkdtemp(join(tmpdir(), 'fly-smoke-'))
  await mkdir(join(fixture, 'alpha'))
  await writeFile(join(fixture, 'file2.txt'), 'hello')
  await writeFile(join(fixture, 'file10.txt'), '')
  await writeFile(join(fixture, '.hidden'), '')
  await symlink(join(fixture, 'alpha'), join(fixture, 'link-to-alpha'))
  await symlink(join(fixture, 'missing'), join(fixture, 'broken-link'))
  await mkdir(join(fixture, 'locked'))
  await chmod(join(fixture, 'locked'), 0o000)

  userData = await mkdtemp(join(tmpdir(), 'fly-smoke-userdata-'))

  server = await startSftpServer('smoke')
  await server.buildFixture()

  // ------------------------------------------------------------------- launch ---

  // Electron honours ELECTRON_RUN_AS_NODE from the parent environment: if it is
  // set the binary runs main.js as a plain Node script and never opens a window.
  // Claude Code and some Electron-hosted editors export it, so strip it.
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env

  child = spawn(
    './node_modules/.bin/electron',
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, HOME: fixture } }
  )
  child.stdout.on('data', (d) => mainLogs.push(d.toString()))
  child.stderr.on('data', (d) => mainLogs.push(d.toString()))

  let page
  for (let i = 0; i < 40 && !page; i++) {
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

  // ------------------------------------------------------------------ helpers ---

  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = res.result?.exceptionDetails
    if (details) throw new Error(`renderer threw: ${JSON.stringify(details).slice(0, 300)}`)
    return res.result?.result?.value
  }

  const evaluate = async (label, expression, check) => {
    let value
    let pass = false
    try {
      value = await run(expression)
      pass = Boolean(check(value))
    } catch (error) {
      value = value ?? error.message
    }
    record(label, value, pass)
  }

  const waitFor = async (expression, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await run(expression)) return true
      } catch {}
      await sleep(100)
    }
    return false
  }

  const codeFrom = (call) =>
    `(async () => { try { await ${call}; return 'NOT REJECTED' } catch (e) {
       const m = e.message; try { return JSON.parse(m.slice(m.indexOf('{'), m.lastIndexOf('}') + 1)).code } catch { return m }
     } })()`

  const pathOf = (scope) => `document.querySelector(${q(`${scope} [data-testid="pane-path"]`)})?.textContent`
  const rowFor = (path) => `document.querySelector('[role="row"][data-path=' + ${q(q(path))} + ']')`
  const rowNames = (scope) =>
    `JSON.stringify([...document.querySelectorAll(${q(`${scope} [role="row"][data-path]`)})].map(r => r.dataset.path.split('/').pop()))`
  const alertIn = (scope) => `document.querySelector(${q(`${scope} [role="alert"]`)})?.textContent ?? ''`
  const inputValue = (name) => `document.querySelector(${q(`${FORM} input[name="${name}"]`)})?.value`
  const titleBar = `document.querySelector('header')?.textContent ?? ''`

  const doubleClick = async (path) => {
    await run(`${rowFor(path)}.scrollIntoView({ block: 'center' })`)
    const box = await run(
      `(() => { const r = ${rowFor(path)}.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`
    )
    for (const clickCount of [1, 2]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount })
    }
  }
  const press = async (key, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }
  /** Real typing into a form field, replacing what is there. */
  const typeInto = async (name, text) => {
    await run(`(() => { const el = document.querySelector(${q(`${FORM} input[name="${name}"]`)}); el.focus(); el.select() })()`)
    await send('Input.insertText', { text })
  }
  const clickButton = async (scope, text) =>
    run(`(() => {
      const button = [...document.querySelectorAll(${q(`${scope} button`)})].find(b => b.textContent.trim() === ${q(text)})
      if (!button) throw new Error('no button ' + ${q(text)})
      button.click()
    })()`)
  const screenshot = async (name) => {
    if (!SHOT_DIR) return
    await mkdir(SHOT_DIR, { recursive: true })
    const png = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(png.result.data, 'base64'))
  }

  const rendered = await waitFor(`document.querySelectorAll(${q(`${LOCAL} [role="row"][data-path]`)}).length > 0`)

  // ------------------------------------------------------------- architecture ---

  await evaluate('renderer mounted with both panes', `!!document.querySelector(${q(LOCAL)}) && !!document.querySelector(${q(FORM)})`, (v) => v === true)
  await evaluate(
    'bridge exposes exactly the approved methods',
    `JSON.stringify({ api: Object.keys(window.api).sort(), local: Object.keys(window.api.local).sort(), sftp: Object.keys(window.api.sftp).sort(), system: Object.keys(window.api.system).sort() })`,
    (v) =>
      v ===
      JSON.stringify({
        api: ['local', 'sftp', 'system'],
        local: ['getHomeDirectory', 'listDirectory'],
        sftp: ['connect', 'disconnect', 'forgetHostKey', 'listDirectory', 'onConnectionClosed', 'trustHostKeyAndConnect'],
        system: ['getVersion']
      })
  )
  await evaluate('node hidden', `[window.require, window.process, window.module].every(v => v === undefined)`, (v) => v === true)
  await evaluate('ipc getVersion', `(async () => JSON.stringify(await window.api.system.getVersion()))()`, (v) => {
    const d = JSON.parse(v)
    return typeof d.electron === 'string' && d.electron.length > 0 && typeof d.app === 'string'
  })
  await evaluate('tailwind applied', `getComputedStyle(document.body).backgroundColor`, (v) => v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent')

  // ------------------------------------------------------- local files over IPC ---

  await evaluate('getHomeDirectory', `window.api.local.getHomeDirectory()`, (v) => v === fixture)
  await evaluate(
    'listDirectory describes the fixture',
    `(async () => JSON.stringify(await window.api.local.listDirectory(${q(fixture)})))()`,
    (v) => {
      const listing = JSON.parse(v)
      const by = Object.fromEntries(listing.entries.map((e) => [e.name, e]))
      return (
        listing.path === fixture &&
        listing.parentPath === dirname(fixture) &&
        Object.keys(by).sort().join() === [...EXPECTED_ORDER].sort().join() &&
        by['file2.txt'].kind === 'file' && by['file2.txt'].size === 5 &&
        by['alpha'].kind === 'directory' && by['alpha'].size === null &&
        by['link-to-alpha'].kind === 'directory' && by['link-to-alpha'].isSymlink === true &&
        by['broken-link'].kind === 'other' && by['broken-link'].isSymlink === true &&
        by['.hidden'].isHidden === true &&
        listing.entries.every((e) => e.path === join(fixture, e.name))
      )
    }
  )
  await evaluate('rejects a relative path', codeFrom(`window.api.local.listDirectory('relative/path')`), (v) => v === 'INVALID_INPUT')
  await evaluate('rejects a NUL byte', codeFrom(`window.api.local.listDirectory(${q(fixture + '\0/..')})`), (v) => v === 'INVALID_INPUT')
  await evaluate('rejects a non-string path', codeFrom(`window.api.local.listDirectory(42)`), (v) => v === 'INVALID_INPUT')
  await evaluate('missing folder is NOT_FOUND', codeFrom(`window.api.local.listDirectory(${q(join(fixture, 'nope'))})`), (v) => v === 'NOT_FOUND')
  await evaluate('a file is NOT_A_DIRECTORY', codeFrom(`window.api.local.listDirectory(${q(join(fixture, 'file2.txt'))})`), (v) => v === 'NOT_A_DIRECTORY')
  await evaluate('unreadable folder is PERMISSION_DENIED', codeFrom(`window.api.local.listDirectory(${q(join(fixture, 'locked'))})`), (v) => v === 'PERMISSION_DENIED')

  // ------------------------------------------------ the local pane, like a user ---

  record('UI local: pane rendered rows', String(rendered), rendered)
  await evaluate(
    'UI local: starts in home, folders first, natural order',
    `JSON.stringify({ path: ${pathOf(LOCAL)}, rows: ${rowNames(LOCAL)} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.path === fixture && d.rows === JSON.stringify(EXPECTED_ORDER)
    }
  )

  await doubleClick(join(fixture, 'alpha'))
  record('UI local: double-click opens a folder', await run(pathOf(LOCAL)), await waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))

  await run(`document.querySelector(${q(`${LOCAL} button[aria-label="Back"]`)}).click()`)
  record(
    'UI local: Back returns and reselects the folder',
    await run(pathOf(LOCAL)),
    await waitFor(`${pathOf(LOCAL)} === ${q(fixture)} && document.querySelector(${q(`${LOCAL} [aria-selected="true"]`)})?.dataset.path === ${q(join(fixture, 'alpha'))}`)
  )

  await run(`document.querySelector(${q(LOCAL)}).focus()`)
  await press('Enter', 'Enter', 13)
  record('UI local: Enter opens the selected folder', await run(pathOf(LOCAL)), await waitFor(`${pathOf(LOCAL)} === ${q(join(fixture, 'alpha'))}`))

  await press('Backspace', 'Backspace', 8)
  record('UI local: Backspace goes to the parent folder', await run(pathOf(LOCAL)), await waitFor(`${pathOf(LOCAL)} === ${q(fixture)}`))

  await writeFile(join(fixture, 'added-later.txt'), '')
  await press('F5', 'F5', 116)
  const refreshed = await waitFor(`!!${rowFor(join(fixture, 'added-later.txt'))}`)
  record('UI local: F5 refreshes the listing', String(refreshed), refreshed)

  await doubleClick(join(fixture, 'locked'))
  await waitFor(`${alertIn(LOCAL)} !== ''`)
  await evaluate(
    'UI local: unreadable folder shows a friendly error and stays put',
    `JSON.stringify({ text: ${alertIn(LOCAL)}, path: ${pathOf(LOCAL)} })`,
    (v) => {
      const d = JSON.parse(v)
      return /permission/i.test(d.text) && !/Error invoking|\bat\s|{/.test(d.text) && d.path === fixture
    }
  )

  // ---------------------------------------------- the remote pane, like a user ---

  const fillAndConnect = async (password) => {
    await typeInto('host', server.host)
    await typeInto('port', String(server.port))
    await typeInto('username', server.username)
    await typeInto('password', password)
    await run(`document.querySelector(${q(`${FORM} button[type="submit"]`)}).click()`)
  }
  const dialogOpen = `!!document.querySelector('[role="dialog"]')`
  const dialogText = (testId) => `document.querySelector('[data-testid="${testId}"]')?.textContent ?? ''`

  // First contact: the key is unknown, so the user is asked.
  await fillAndConnect(server.password)
  const prompted = await waitFor(`!!document.querySelector('[data-testid="host-key-fingerprint"]')`, 15000)
  const shownFingerprint = await run(dialogText('host-key-fingerprint'))
  const keyscan = await server.keyscanFingerprints()
  await screenshot('1-host-key-prompt')
  record(
    'UI remote: unknown server shows the fingerprint OpenSSH reports',
    { shownFingerprint, keyscan },
    prompted && keyscan.includes(shownFingerprint)
  )
  await evaluate('UI remote: password field is cleared once sent', inputValue('password'), (v) => v === '')

  await clickButton('[role="dialog"]', 'Trust and connect')
  const connected = await waitFor(`${pathOf(REMOTE)} === '/config'`, 15000)
  await evaluate(
    'UI remote: trusted and connected, in the home folder',
    `JSON.stringify({ connected: ${connected}, subtitle: document.querySelector(${q(`${REMOTE} [data-testid="pane-subtitle"]`)})?.textContent, title: ${titleBar} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.connected && d.subtitle === `fly@127.0.0.1:${server.port}` && d.title.includes('Connected to fly@127.0.0.1')
    }
  )

  await waitFor(`!!${rowFor('/config/fixture')}`)
  await doubleClick('/config/fixture')
  await waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  await waitFor(`!!${rowFor('/config/fixture/alpha')}`)
  await screenshot('2-remote-fixture')
  if (SHOT_DIR) {
    // The tightest layout: both panes at the minimum window width (960 px).
    // Electron doesn't implement CDP window bounds, so emulate the viewport.
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 0, mobile: false })
    await sleep(400)
    await screenshot('2b-remote-fixture-min-width')
    await send('Emulation.clearDeviceMetricsOverride')
    await sleep(200)
  }
  await evaluate(
    'UI remote: lists the server folder, folders first, natural order',
    `JSON.stringify({ path: ${pathOf(REMOTE)}, rows: ${rowNames(REMOTE)} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.path === '/config/fixture' && d.rows === JSON.stringify(EXPECTED_ORDER)
    }
  )

  await doubleClick('/config/fixture/alpha')
  const intoRemoteAlpha = await waitFor(`${pathOf(REMOTE)} === '/config/fixture/alpha'`)
  await run(`document.querySelector(${q(`${REMOTE} button[aria-label="Back"]`)}).click()`)
  const backRemote = await waitFor(`${pathOf(REMOTE)} === '/config/fixture'`)
  record('UI remote: double-click opens a folder and Back returns', await run(pathOf(REMOTE)), intoRemoteAlpha && backRemote)

  await doubleClick('/config/fixture/locked')
  await waitFor(`${alertIn(REMOTE)} !== ''`)
  await evaluate(
    'UI remote: unreadable server folder shows a friendly error and stays put',
    `JSON.stringify({ text: ${alertIn(REMOTE)}, path: ${pathOf(REMOTE)} })`,
    (v) => {
      const d = JSON.parse(v)
      return /permission/i.test(d.text) && !/Error invoking|\bat\s|{/.test(d.text) && d.path === '/config/fixture'
    }
  )

  const isolatedStore = await readFile(join(userData, 'known-hosts.json'), 'utf8').catch(() => '')
  const realTrustAfter = await readFile(realTrustStore, 'utf8').catch(() => null)
  record(
    'trust store written to the isolated data folder only',
    { isolated: isolatedStore.includes(`[127.0.0.1]:${server.port}`), realUnchanged: realTrustAfter === realTrustBefore },
    isolatedStore.includes(`[127.0.0.1]:${server.port}`) && realTrustAfter === realTrustBefore
  )

  // Disconnect: back to the form, target kept, password not.
  await clickButton(REMOTE, 'Disconnect')
  const formBack = await waitFor(`!!document.querySelector(${q(FORM)})`)
  await evaluate(
    'UI remote: Disconnect returns to the form, keeping host and user but not the password',
    `JSON.stringify({ formBack: ${formBack}, host: ${inputValue('host')}, username: ${inputValue('username')}, password: ${inputValue('password')}, title: ${titleBar} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.formBack && d.host === '127.0.0.1' && d.username === 'fly' && d.password === '' && d.title.includes('Not connected')
    }
  )

  // A trusted server connects without asking again.
  await typeInto('password', server.password)
  await run(`document.querySelector(${q(`${FORM} button[type="submit"]`)}).click()`)
  let sawDialog = false
  const deadline = Date.now() + 15000
  let reconnected = false
  while (Date.now() < deadline && !reconnected) {
    sawDialog = sawDialog || (await run(dialogOpen))
    reconnected = await run(`${pathOf(REMOTE)} === '/config'`)
    if (!reconnected) await sleep(100)
  }
  record('UI remote: reconnecting to a trusted server does not ask again', { reconnected, sawDialog }, reconnected && !sawDialog)

  // The server drops every session.
  await server.killSessions()
  const lostShown = await waitFor(`${alertIn(FORM)}.includes('Network connection lost')`, 10000)
  await evaluate(
    'UI remote: a dropped connection says so and returns to the form',
    `JSON.stringify({ shown: ${lostShown}, host: ${inputValue('host')}, username: ${inputValue('username')}, password: ${inputValue('password')} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.shown && d.host === '127.0.0.1' && d.username === 'fly' && d.password === ''
    }
  )

  // Wrong password.
  await typeInto('password', 'definitely-wrong')
  await run(`document.querySelector(${q(`${FORM} button[type="submit"]`)}).click()`)
  const authShown = await waitFor(`${alertIn(FORM)}.includes('Authentication failed')`, 15000)
  record('UI remote: wrong password shows a friendly message', await run(alertIn(FORM)), authShown && !/Error invoking|{/.test(await run(alertIn(FORM))))

  // The server's identity changes.
  await server.rotateHostKeys()
  const rotated = await server.keyscanFingerprints()
  await typeInto('password', server.password)
  await run(`document.querySelector(${q(`${FORM} button[type="submit"]`)}).click()`)
  const warned = await waitFor(`!!document.querySelector('[data-testid="host-key-offered"]')`, 15000)
  await screenshot('3-host-key-changed')
  const saved = await run(dialogText('host-key-saved'))
  const offered = await run(dialogText('host-key-offered'))
  const warningText = await run(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
  record(
    'UI remote: a changed host key is refused with both fingerprints',
    { saved, offered },
    warned && saved === shownFingerprint && rotated.includes(offered) && saved !== offered && warningText.includes('password was not sent')
  )

  await clickButton('[role="dialog"]', 'I know why it changed…')
  await clickButton('[role="dialog"]', 'Forget saved key')
  const noticed = await waitFor(`(document.querySelector(${q(`${FORM} [role="status"]`)})?.textContent ?? '').includes('saved key was removed')`)
  await typeInto('password', server.password)
  await run(`document.querySelector(${q(`${FORM} button[type="submit"]`)}).click()`)
  const reprompted = await waitFor(`!!document.querySelector('[data-testid="host-key-fingerprint"]')`, 15000)
  const reFingerprint = await run(dialogText('host-key-fingerprint'))
  record('UI remote: after forgetting, the new key is offered for review', { noticed, reFingerprint }, noticed && reprompted && reFingerprint === offered)
  await clickButton('[role="dialog"]', 'Cancel')
  record('UI remote: cancelling the prompt closes it without connecting', '', await waitFor(`!${dialogOpen} && !!document.querySelector(${q(FORM)})`))

  ws.close()
} catch (err) {
  record('FATAL', err.stack ?? err.message, false)
} finally {
  child?.kill('SIGTERM')
  await sleep(300)
  await server?.remove()
  if (fixture) {
    await chmod(join(fixture, 'locked'), 0o755).catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  }
  if (userData) await rm(userData, { recursive: true, force: true })
}

// Secrets must never reach the log. Checked against output that demonstrably
// covers the connection, so an empty log cannot pass it.
if (server) {
  const logText = mainLogs.join('')
  record(
    'the password never appears in the main-process log',
    { logCoversConnections: logText.includes('"message":"Connected"'), leaked: logText.includes(server.password) },
    logText.includes('"message":"Connected"') && !logText.includes(server.password)
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
console.log(
  `\n${total - failed.length}/${total} checks passed` + (failed.length ? `: ${failed.map(([l]) => l).join(', ')}` : '')
)
process.exit(failed.length > 0 || total === 0 ? 1 : 0)
