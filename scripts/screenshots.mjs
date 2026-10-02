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
    'head -c 900000 /dev/urandom > /config/logs/access.log',
    'head -c 120000 /dev/urandom > /config/logs/error.log',
    'head -c 3000000 /dev/urandom > /config/releases/build-184.tar.gz',
    'chown -R 1000:1000 /config/www /config/logs /config/releases'
  ].join(' && ')
)

const home = await makeHome()
const userData = await mkdtemp(join(tmpdir(), 'filebird-shots-data-'))
await rm(SHOTS, { recursive: true, force: true })
await mkdir(SHOTS, { recursive: true })

const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env
const child = spawn(join(ROOT, 'node_modules/.bin/electron'), [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
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

// A transfer: download the whole folder's assets.
await clickSelector(`${REMOTE} [role="row"][data-path="/config/www/assets"]`)
await waitFor(`document.querySelector(${q(`${REMOTE} [data-testid="pane-path"]`)}).textContent === '/config/www/assets'`)
await js(`[...document.querySelectorAll(${q(`${REMOTE} [role="row"][data-path]`)})].forEach((row, index) => { if (index === 0) row.click() })`)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
await clickText(REMOTE, 'Download')
await sleep(1_200)
await shot('08-transfers')

// The terminal, on the server, over the same connection.
await clickSelector(`${REMOTE} [data-testid="tab-terminal"]`)
await waitFor(`!!document.querySelector(${q(`${REMOTE} .xterm-rows`)})`, 20_000)
await sleep(1_500)
await js(`document.querySelector(${q(`${REMOTE} .xterm-helper-textarea`)})?.focus()`)
await send('Input.insertText', { text: 'uname -a; df -h /config | tail -1; ls -la' })
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(1_500)
await shot('09-terminal')
await clickSelector(`${REMOTE} [data-testid="tab-files"]`)

// Searching a folder.
await clickSelector(`${LOCAL} [data-testid="tab-files"]`)
await js(`[...document.querySelectorAll(${q(`${LOCAL} button`)})].find((b) => b.getAttribute('aria-label') === 'Search this folder')?.click()`)
await waitFor(`!!document.querySelector(${q(`${LOCAL} [data-testid="pane-search"]`)})`)
await type(`${LOCAL} [data-testid="pane-search"]`, 'web')
await sleep(600)
await shot('10-search')

// Last: the connections list, with a server saved in it.
await clickSelector(`${LOCAL} [data-testid="search-close"]`)
await js(`[...document.querySelectorAll(${q(`${LOCAL} button`)})].find((b) => b.getAttribute('aria-label') === 'Parent folder')?.click()`)
await waitFor(`document.querySelector(${q(`${LOCAL} [data-testid="pane-path"]`)}).textContent.endsWith('FileBird Demo')`)
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
