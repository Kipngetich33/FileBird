// End-to-end smoke test: launches the built app and drives the real renderer
// over CDP, so the whole preload -> IPC -> main chain is exercised for real.
//
// A fixture directory is built first and the app is launched with HOME pointed
// at it, so the local pane starts somewhere with known contents.
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- fixture ---

const fixture = await mkdtemp(join(tmpdir(), 'fly-smoke-'))
await mkdir(join(fixture, 'alpha'))
await writeFile(join(fixture, 'file2.txt'), 'hello')
await writeFile(join(fixture, 'file10.txt'), '')
await writeFile(join(fixture, '.hidden'), '')
await symlink(join(fixture, 'alpha'), join(fixture, 'link-to-alpha'))
await symlink(join(fixture, 'missing'), join(fixture, 'broken-link'))
await mkdir(join(fixture, 'locked'))
await chmod(join(fixture, 'locked'), 0o000)

const EXPECTED_ORDER = [
  'alpha',
  'link-to-alpha',
  'locked',
  '.hidden',
  'broken-link',
  'file2.txt',
  'file10.txt'
]

// ------------------------------------------------------------------- launch ---

// Electron honours ELECTRON_RUN_AS_NODE from the parent environment: if it is
// set the binary runs main.js as a plain Node script and never opens a window,
// so no page target ever appears. Claude Code and some Electron-hosted editors
// export it, so strip it (and its console sibling) for the child.
const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env

const child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${PORT}`], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...inherited, HOME: fixture }
})

const mainLogs = []
child.stdout.on('data', (d) => mainLogs.push(d.toString()))
child.stderr.on('data', (d) => mainLogs.push(d.toString()))

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('No page target appeared')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id
      pending.set(n, resolve)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
}

// ------------------------------------------------------------------- checks ---

const results = []
try {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const send = cdp(ws)
  await send('Runtime.enable')

  const run = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = res.result?.exceptionDetails
    if (details) throw new Error(`renderer threw: ${JSON.stringify(details).slice(0, 300)}`)
    return res.result?.result?.value
  }

  // `check` decides pass/fail; a renderer exception or a throwing predicate fails.
  const evaluate = async (label, expression, check) => {
    let value
    let pass = false
    try {
      value = await run(expression)
      pass = Boolean(check(value))
    } catch (error) {
      value = value ?? error.message
    }
    results.push([label, typeof value === 'string' ? value : JSON.stringify(value), pass])
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

  // Calls a bridged method in the renderer and reports the error code it failed with.
  const codeFrom = (call) =>
    `(async () => { try { await ${call}; return 'NOT REJECTED' } catch (e) {
       const m = e.message; try { return JSON.parse(m.slice(m.indexOf('{'), m.lastIndexOf('}') + 1)).code } catch { return m }
     } })()`

  const q = (value) => JSON.stringify(value)
  const panePath = `document.querySelector('[data-testid="pane-path"]')?.textContent`
  const rowFor = (path) => `document.querySelector('[role="row"][data-path=' + ${q(q(path))} + ']')`

  // Real input events, not element.click(), so focus and key handling are exercised.
  const doubleClick = async (path) => {
    const box = await run(`(() => { const r = ${rowFor(path)}.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 } })()`)
    for (const clickCount of [1, 2]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount })
    }
  }
  const press = async (key, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }

  const rendered = await waitFor(`document.querySelectorAll('[role="row"][data-path]').length > 0`)

  // --- architecture --------------------------------------------------------

  await evaluate('renderer mounted with the local pane', `!!document.querySelector('[aria-label="Local files"]')`, (v) => v === true)
  await evaluate(
    'bridge exposes exactly the approved methods',
    `JSON.stringify({ api: Object.keys(window.api).sort(), local: Object.keys(window.api.local).sort(), system: Object.keys(window.api.system).sort() })`,
    (v) => v === JSON.stringify({ api: ['local', 'system'], local: ['getHomeDirectory', 'listDirectory'], system: ['getVersion'] })
  )
  await evaluate('node hidden', `[window.require, window.process, window.module].every(v => v === undefined)`, (v) => v === true)
  await evaluate('ipc getVersion', `(async () => JSON.stringify(await window.api.system.getVersion()))()`, (v) => {
    const d = JSON.parse(v)
    return typeof d.electron === 'string' && d.electron.length > 0 && typeof d.app === 'string'
  })
  await evaluate('tailwind applied', `getComputedStyle(document.body).backgroundColor`, (v) => v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent')

  // --- local files over IPC -----------------------------------------------

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

  // --- the pane, driven like a user --------------------------------------

  results.push(['UI: pane rendered rows', String(rendered), rendered])
  await evaluate(
    'UI: starts in home, folders first, natural order',
    `JSON.stringify({ path: ${panePath}, rows: [...document.querySelectorAll('[role="row"][data-path]')].map(r => r.dataset.path.split('/').pop()) })`,
    (v) => {
      const d = JSON.parse(v)
      return d.path === fixture && JSON.stringify(d.rows) === JSON.stringify(EXPECTED_ORDER)
    }
  )

  await doubleClick(join(fixture, 'alpha'))
  const intoAlpha = await waitFor(`${panePath} === ${q(join(fixture, 'alpha'))}`)
  results.push(['UI: double-click opens a folder', await run(panePath), intoAlpha])

  await run(`document.querySelector('button[aria-label="Back"]').click()`)
  const backHome = await waitFor(`${panePath} === ${q(fixture)} && document.querySelector('[aria-selected="true"]')?.dataset.path === ${q(join(fixture, 'alpha'))}`)
  results.push(['UI: Back returns and reselects the folder', await run(panePath), backHome])

  // alpha is selected now; drive the rest from the keyboard.
  await run(`document.querySelector('[aria-label="Local files"]').focus()`)
  await press('Enter', 'Enter', 13)
  const enterOpened = await waitFor(`${panePath} === ${q(join(fixture, 'alpha'))}`)
  results.push(['UI: Enter opens the selected folder', await run(panePath), enterOpened])

  await press('Backspace', 'Backspace', 8)
  const backspaceUp = await waitFor(`${panePath} === ${q(fixture)}`)
  results.push(['UI: Backspace goes to the parent folder', await run(panePath), backspaceUp])

  // A file created after the listing was loaded only appears once refreshed.
  await writeFile(join(fixture, 'added-later.txt'), '')
  await press('F5', 'F5', 116)
  const refreshed = await waitFor(`!!${rowFor(join(fixture, 'added-later.txt'))}`)
  results.push(['UI: F5 refreshes the listing', String(refreshed), refreshed])

  await doubleClick(join(fixture, 'locked'))
  const alerted = await waitFor(`!!document.querySelector('[role="alert"]')`)
  await evaluate(
    'UI: unreadable folder shows a friendly error and stays put',
    `JSON.stringify({ shown: ${alerted}, text: document.querySelector('[role="alert"]')?.textContent ?? '', path: ${panePath} })`,
    (v) => {
      const d = JSON.parse(v)
      return d.shown && /permission/i.test(d.text) && !/Error invoking|\bat\s|INVALID|{/.test(d.text) && d.path === fixture
    }
  )

  ws.close()
} catch (err) {
  results.push(['FATAL', err.message, false])
} finally {
  child.kill('SIGTERM')
  await chmod(join(fixture, 'locked'), 0o755).catch(() => {})
  await rm(fixture, { recursive: true, force: true })
}

// ------------------------------------------------------------------- report ---

for (const [label, value, pass] of results) {
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  [${label}]\n  ${String(value).slice(0, 400)}`)
}

const failed = results.filter(([, , pass]) => !pass)
if (failed.length > 0 || results.length === 0) {
  console.log('\n=== MAIN PROCESS LOG ===')
  console.log(mainLogs.join('').trim().slice(0, 2000) || '(empty)')
}

const total = results.length
console.log(
  `\n${total - failed.length}/${total} checks passed` +
    (failed.length ? `: ${failed.map(([l]) => l).join(', ')}` : '')
)
process.exit(failed.length > 0 || total === 0 ? 1 : 0)
