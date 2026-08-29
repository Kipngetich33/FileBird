// End-to-end smoke test: launches the built app and drives the real renderer
// over CDP, so the whole preload -> IPC -> main chain is exercised for real.
import { spawn } from 'node:child_process'

const PORT = 9222

// Electron honours ELECTRON_RUN_AS_NODE from the parent environment: if it is
// set the binary runs main.js as a plain Node script and never opens a window,
// so no page target ever appears. Claude Code and some Electron-hosted editors
// export it, so strip it (and its console sibling) for the child.
const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...childEnv } = process.env

const child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${PORT}`], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv
})

const mainLogs = []
child.stdout.on('data', (d) => mainLogs.push(d.toString()))
child.stderr.on('data', (d) => mainLogs.push(d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const results = []
try {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const send = cdp(ws)
  await send('Runtime.enable')

  // `check` decides pass/fail. A thrown renderer exception leaves value
  // undefined, which every predicate treats as a failure.
  const evaluate = async (label, expression, check) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    const details = res.result?.exceptionDetails
    const value = details ? JSON.stringify(details) : res.result?.result?.value
    let pass = false
    try {
      pass = !details && check(value)
    } catch {
      pass = false
    }
    results.push([label, value, pass])
  }

  // Give React a moment to mount.
  await sleep(1200)

  await evaluate(
    'renderer mounted',
    `document.querySelector('h1')?.textContent ?? 'NO H1'`,
    (v) => typeof v === 'string' && v.length > 0 && v !== 'NO H1'
  )
  await evaluate(
    'preload bridge',
    `typeof window.api?.system?.getVersion`,
    (v) => v === 'function'
  )
  await evaluate(
    'node hidden',
    `[window.require, window.process, window.module].every(v => v === undefined)`,
    (v) => v === true
  )
  await evaluate(
    'ipc getVersion',
    `(async () => JSON.stringify(await window.api.system.getVersion()))()`,
    (v) => {
      const d = JSON.parse(v)
      return typeof d.electron === 'string' && d.electron.length > 0 && typeof d.app === 'string'
    }
  )
  await evaluate(
    'ipc ping',
    `(async () => JSON.stringify(await window.api.system.ping('hello from smoke test')))()`,
    (v) => JSON.parse(v).message === 'hello from smoke test'
  )
  await evaluate(
    'ipc validation rejects oversized input',
    `(async () => { try { await window.api.system.ping('x'.repeat(500)); return 'NOT REJECTED' } catch (e) { return e.message } })()`,
    (v) => typeof v === 'string' && v.includes('INVALID_INPUT')
  )
  await evaluate(
    'tailwind applied',
    `getComputedStyle(document.body).backgroundColor`,
    // A missing stylesheet leaves the body transparent.
    (v) => typeof v === 'string' && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent'
  )

  ws.close()
} catch (err) {
  results.push(['FATAL', err.message, false])
} finally {
  child.kill('SIGTERM')
}

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
