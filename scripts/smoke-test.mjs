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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { startSftpServer } from '../test/support/sftp-container.ts'
import { TEST_PASSPHRASE, generateTestKeys, sshKeygenFingerprint } from '../test/support/ssh-keys.ts'

const run = promisify(execFile)
const PORT = 9222
const SHOT_DIR = process.env.SMOKE_SCREENSHOT_DIR
const KEYCHAIN_SERVICE = 'Fly (development)'
const ELECTRON = './node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  const child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
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

  const js = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = res.result?.exceptionDetails
    if (details) throw new Error(`renderer threw: ${JSON.stringify(details).slice(0, 300)}`)
    return res.result?.result?.value
  }

  const self = {
    send,
    js,
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
    async press(key, code, keyCode) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
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
        connections: ['connect', 'connectUnsaved', 'create', 'delete', 'forgetSecret', 'list', 'update'],
        keys: ['inspect', 'pick'],
        local: ['getHomeDirectory', 'listDirectory'],
        sftp: ['disconnect', 'forgetHostKey', 'listDirectory', 'onConnectionClosed', 'trustHostKeyAndConnect'],
        sshConfig: ['import', 'preview'],
        system: ['getVersion']
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
  await app.click(REMOTE, 'Disconnect')
  await app.waitFor(exists(profileRow('Smoke key')))

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
  await app.click(DIALOG, 'Cancel')

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
