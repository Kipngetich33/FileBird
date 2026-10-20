// Takes the screenshots used in README.md, by driving the built app for real.
//
//   npm run build && npm run screenshots        (needs Colima: colima start fly)
//
// It makes a small, readable home folder, starts the usual test server, connects
// to it through the UI, and captures each screen into screenshots/. Everything
// it creates is temporary; nothing touches the real home folder or Downloads.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSftpServer } from '../test/support/sftp-container.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'screenshots')
const PORT = 9420
/** The main process's own inspector: menu commands can only be clicked from there. */
const INSPECT = 9421
const WIDTH = 1280
const HEIGHT = 820
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = JSON.stringify

/**
 * A home folder that looks like someone's, rather than like a test fixture: the
 * path is in the pictures, so a temporary folder would read as /var/folders/...
 * It is removed again at the end.
 */
async function makeHome() {
  const home = join(homedir(), 'FileBird Demo')
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  const tree = {
    'Documents/Invoices': ['March 2026.pdf', 'April 2026.pdf'],
    'Documents/Reports': ['Quarterly review.pdf', 'Site survey.docx'],
    Photos: ['beach.jpg', 'city at night.jpg', 'portrait.jpg'],
    'Projects/filebird': ['README.md', 'package.json'],
    'Projects/website': ['index.html', 'styles.css', 'deploy.sh']
  }
  for (const [folder, files] of Object.entries(tree)) {
    await mkdir(join(home, folder), { recursive: true })
    for (const [index, name] of files.entries()) {
      await writeFile(join(home, folder, name), Buffer.alloc(4_096 * (index + 3), 7))
    }
  }
  await mkdir(join(home, 'Downloads'), { recursive: true })
  await writeFile(join(home, 'notes.md'), '# Notes\n')
  await writeFile(join(home, 'backup.tar.gz'), Buffer.alloc(2_400_000, 3))
  return home
}

const server = await startSftpServer('shots')
await server.buildFixture()
await server.exec(
  [
    'mkdir -p /config/www/assets /config/logs /config/releases',
    'printf "<!doctype html>" > /config/www/index.html',
    'head -c 180000 /dev/urandom > /config/www/assets/app.js',
    'head -c 40000 /dev/urandom > /config/www/assets/styles.css',
    // Readable lines, not random bytes: these end up on screen in the terminal shots.
    'i=1; while [ $i -le 4000 ]; do echo "10.0.2.$((i%250)) - - [20/Oct/2026:09:$((i%60)):12 +0000] \\"GET /assets/app.js HTTP/1.1\\" 200 184320"; i=$((i+1)); done > /config/logs/access.log',
    'printf "%s\\n" "[error] 2026/10/20 09:14:02 upstream timed out (110: Operation timed out) while reading response header" "[warn] 2026/10/20 09:14:03 upstream server temporarily disabled while reading response header" "[error] 2026/10/20 09:15:41 open() \\"/config/www/favicon.ico\\" failed (2: No such file or directory)" > /config/logs/error.log',
    'head -c 3000000 /dev/urandom > /config/releases/build-184.tar.gz',
    'chown -R 1000:1000 /config/www /config/logs /config/releases'
  ].join(' && ')
)

const home = await makeHome()
const userData = await mkdtemp(join(tmpdir(), 'filebird-shots-data-'))
await rm(SHOTS, { recursive: true, force: true })
await mkdir(SHOTS, { recursive: true })

const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env
const child = spawn(join(ROOT, 'node_modules/.bin/electron'), [`--inspect=${INSPECT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  env: { ...inherited, FLY_DEV_HOME: home, FLY_DEV_DOWNLOADS: join(home, 'Downloads') },
  stdio: 'ignore'
})

/** The page, once the app has one that isn't the start screen. */
async function connect(match) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const target = targets.find(match)
      if (target) return target
    } catch {}
    await sleep(250)
  }
  throw new Error('no page target')
}

const open = async (target) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  let id = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      const listener = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== n) return
        socket.removeEventListener('message', listener)
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
      }
      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({ id: n, method, params }))
    })
  const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
  const waitFor = async (expression, ms = 20_000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(150)) if (await js(expression).catch(() => false)) return true
    return false
  }
  return { socket, send, js, waitFor }
}

// The start screen is its own window, and it is gone after a few seconds.
const splash = await open(await connect((target) => target.url.includes('splash.html')))
await sleep(2_600)
await writeFile(join(SHOTS, '01-start-screen.png'), Buffer.from((await splash.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
splash.socket.close()

const app = await open(await connect((target) => target.type === 'page' && !target.url.includes('splash.html')))
const { js, send, waitFor } = app
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false })
const shot = async (name) => {
  await sleep(500)
  const image = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(image.data, 'base64'))
  console.log(`captured ${name}`)
}
const clickText = async (scope, text) => {
  const point = await js(`(() => {
    const button = [...document.querySelectorAll(${q(`${scope} button`)})].find((b) => b.textContent.trim() === ${q(text)})
    if (!button) return null
    const r = button.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!point) throw new Error(`no button "${text}" in ${scope}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  }
}
const clickSelector = async (selector) => {
  const point = await js(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!point) throw new Error(`no element ${selector}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  }
}
const type = async (selector, text) => {
  await js(`(() => { const el = document.querySelector(${q(selector)}); el.focus(); el.select?.() })()`)
  await send('Input.insertText', { text })
}

/** Clicks an application menu item by id, exactly as choosing it from the menu bar would. */
const mainSocket = await (async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json()
      const url = targets[0]?.webSocketDebuggerUrl
      if (url) {
        const socket = new WebSocket(url)
        await new Promise((resolve) => socket.addEventListener('open', resolve))
        return socket
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('no main-process inspector')
})()
let mainId = 0
const mainPending = new Map()
mainSocket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && mainPending.has(message.id)) {
    mainPending.get(message.id)(message)
    mainPending.delete(message.id)
  }
})
const mainEval = (expression) =>
  new Promise((resolve) => {
    const n = ++mainId
    mainPending.set(n, (message) => resolve(message.result?.result?.value))
    mainSocket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
const clickMenu = async (id) => {
  const result = await mainEval(`(() => { const item = process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById(${q(id)}); if (!item) return 'missing'; item.click(); return 'clicked' })()`)
  if (result !== 'clicked') throw new Error(`menu item ${id}: ${result}`)
  await sleep(400)
}

// A real drag, intercepted so its data is known, then hovered over the target.
let dragged = null
app.socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Input.dragIntercepted') dragged = message.params.data
})
const boxOf = (selector) =>
  js(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
const dragOver = async (fromSelector, toSelector) => {
  const from = await boxOf(fromSelector)
  const to = await boxOf(toSelector)
  if (from === null || to === null) throw new Error('nothing to drag')
  dragged = null
  await send('Input.setInterceptDrags', { enabled: true })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (const step of [6, 14, 26, 40]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + step, y: from.y + step / 2, button: 'left', buttons: 1 })
    if (dragged !== null) break
    await sleep(120)
  }
  for (let attempt = 0; attempt < 40 && dragged === null; attempt += 1) await sleep(100)
  if (dragged === null) throw new Error('the drag was not intercepted')
  for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: dragged })
  return { to, drop: () => send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: dragged }) }
}

const LOCAL = '[aria-label="Local files"]'
const REMOTE = '[aria-label="Remote files"]'
const PANE = '[aria-label="Remote connection"]'
const FORM = '[aria-label="New connection"]'

await waitFor(`!!document.querySelector(${q(`${LOCAL} [role="row"][data-path]`)})`)

// Connect to the server, the way someone would the first time.
await clickText(PANE, 'New connection')
await waitFor(`!!document.querySelector(${q(FORM)})`)
await type(`${FORM} input[name="name"]`, 'Staging server')
await type(`${FORM} input[name="host"]`, server.host)
await type(`${FORM} input[name="port"]`, String(server.port))
await type(`${FORM} input[name="username"]`, server.username)
await clickSelector(`${FORM} input[name="auth"][value="password"]`)
await shot('03-new-connection')
await clickText(FORM, 'Save & connect')
await waitFor(`!!document.querySelector('input[name="secret"]')`, 20_000)
await type('input[name="secret"]', server.password)
await shot('04-password-prompt')
await clickText('[role="dialog"]', 'Connect')
// First connection to a server: its key is shown before anything is trusted.
await waitFor(`document.body.innerText.includes('first time')`, 20_000)
await shot('05-host-key')
await clickText('[role="dialog"]', 'Trust and connect')
await waitFor(`!!document.querySelector(${q(`${REMOTE} [role="row"][data-path]`)})`, 30_000)
await shot('06-connected')

// Browsing: open a folder on each side.
await clickSelector(`${LOCAL} [role="row"][data-path$="Projects"]`)
await waitFor(`document.querySelector(${q(`${LOCAL} [data-testid="pane-path"]`)}).textContent.endsWith('Projects')`)
await clickSelector(`${REMOTE} [role="row"][data-path="/config/www"]`)
await waitFor(`document.querySelector(${q(`${REMOTE} [data-testid="pane-path"]`)}).textContent === '/config/www'`)
await shot('07-browsing')

// Dragging a folder from the server onto this computer: caught mid-drag, with
// the label that says where it would land.
const drag = await dragOver(`${REMOTE} [role="row"][data-path="/config/www/assets"]`, `${LOCAL} [role="row"][data-path$="website"]`)
await sleep(400)
await shot('08-drag-and-drop')
await drag.drop()
await sleep(1_500)
await shot('09-transfers')

// The terminal, on the server, over the same connection.
await clickSelector(`${REMOTE} [data-testid="tab-terminal"]`)
await waitFor(`!!document.querySelector(${q(`${REMOTE} .xterm-rows`)})`, 20_000)
await sleep(1_500)
const typeInTerminal = async (scope, line) => {
  await js(`document.querySelector(${q(`${scope} [data-showing] .xterm-helper-textarea`)})?.focus()`)
  await send('Input.insertText', { text: line })
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
await typeInTerminal(REMOTE, 'uname -a; df -h /config | tail -1; ls -la')
await sleep(1_500)
await shot('10-terminal')

// The same terminal, divided: one half per job, each its own shell.
await clickMenu('command:split-terminal-right')
await waitFor(`document.querySelectorAll(${q(`${REMOTE} [data-showing] [data-pane]`)}).length === 2`, 20_000)
await sleep(1_800)
await typeInTerminal(REMOTE, 'du -sh /config/www /config/logs; echo; tail -4 /config/logs/access.log')
await sleep(1_500)
await shot('11-terminal-split')
await clickSelector(`${REMOTE} [data-testid="tab-files"]`)

// Searching a folder.
await clickSelector(`${LOCAL} [data-testid="tab-files"]`)
await js(`[...document.querySelectorAll(${q(`${LOCAL} button`)})].find((b) => b.getAttribute('aria-label') === 'Search this folder')?.click()`)
await waitFor(`!!document.querySelector(${q(`${LOCAL} [data-testid="pane-search"]`)})`)
await type(`${LOCAL} [data-testid="pane-search"]`, 'web')
await sleep(600)
await shot('12-search')
await clickSelector(`${LOCAL} [data-testid="search-close"]`)

// Back to the home folder, where the demo files are.
await js(`[...document.querySelectorAll(${q(`${LOCAL} button`)})].find((b) => b.getAttribute('aria-label') === 'Parent folder')?.click()`)
await waitFor(`document.querySelector(${q(`${LOCAL} [data-testid="pane-path"]`)}).textContent.endsWith('FileBird Demo')`)

// Making a folder, and the question asked before anything is deleted.
await clickMenu('command:focus-local')
await clickMenu('command:new-folder')
await waitFor(`!!document.querySelector('[role="dialog"]')`)
await sleep(400)
await shot('13-new-folder')
await clickText('[role="dialog"]', 'Cancel')
await sleep(400)
await clickSelector(`${LOCAL} [role="row"][data-path$="backup.tar.gz"]`)
await clickMenu('command:delete')
await waitFor(`document.body.innerText.includes('Trash')`, 10_000)
await sleep(400)
await shot('14-delete')
await clickText('[role="dialog"]', 'Cancel')

// Last: the connections list, with a server saved in it.
await clickText(REMOTE, 'Disconnect')
await waitFor(`document.body.innerText.includes('Saved servers')`, 20_000)
await shot('02-saved-connections')

await app.socket.close()
child.kill('SIGTERM')
await sleep(800)
child.kill('SIGKILL')
await server.remove()
await rm(home, { recursive: true, force: true })
await rm(userData, { recursive: true, force: true })
console.log(`\nScreenshots are in ${SHOTS}`)
process.exit(0)
