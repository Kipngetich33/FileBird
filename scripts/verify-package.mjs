// Verifies a packaged build (Milestone 10).
//
// macOS (.app): signature, fuses and bundled native modules, then launches it
// with a throwaway profile and uses it against a real OpenSSH server in a
// container (needs `colima start fly`). A build for another CPU (arm64 on an
// Intel Mac) is checked statically only.
//
// Windows / Linux (the unpacked folder electron-builder leaves in release/):
// static checks only — fuses, the keychain binary, executable format.
//
//   npm run verify:package -- release/mac/FileBird.app        # default on an Intel Mac
//   npm run verify:package -- release/win-unpacked
//   npm run verify:package -- release/linux-unpacked
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { startSftpServer } from '../test/support/sftp-container.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => JSON.stringify(value)
const DEBUG_PORT = 9261
const INSPECT_PORT = 9263

const appPath = process.argv[2] ?? join('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'FileBird.app')
const platform = appPath.replace(/\/$/, '').endsWith('.app') ? 'darwin' : existsSync(join(appPath, 'FileBird.exe')) ? 'win32' : 'linux'
const binary = platform === 'darwin' ? join(appPath, 'Contents', 'MacOS', 'FileBird') : join(appPath, platform === 'win32' ? 'FileBird.exe' : 'fly')
const unpacked =
  platform === 'darwin'
    ? join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
    : join(appPath, 'resources', 'app.asar.unpacked', 'node_modules')

const EXPECTED_FUSES = {
  RunAsNode: 'off',
  EnableNodeOptionsEnvironmentVariable: 'off',
  EnableNodeCliInspectArguments: 'off',
  EnableEmbeddedAsarIntegrityValidation: 'on',
  OnlyLoadAppFromAsar: 'on',
  EnableCookieEncryption: 'on'
}

async function readFuses(path) {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
  const wire = await getCurrentFuseWire(path)
  const state = (name) => (wire[FuseV1Options[name]] === 49 ? 'on' : wire[FuseV1Options[name]] === 48 ? 'off' : 'unknown')
  return Object.fromEntries(Object.keys(EXPECTED_FUSES).map((name) => [name, state(name)]))
}

async function keyringBinaries() {
  const packages = (await readdir(join(unpacked, '@napi-rs'))).filter((name) => name.startsWith('keyring-'))
  return Promise.all(
    packages.map(async (name) => {
      const files = (await readdir(join(unpacked, '@napi-rs', name))).filter((file) => file.endsWith('.node'))
      return { name, format: (await run('file', ['-b', join(unpacked, '@napi-rs', name, files[0] ?? '')])).stdout.trim() }
    })
  )
}

/**
 * The terminal's prebuilt binaries, which must sit outside the asar: node-pty
 * loads pty.node and runs spawn-helper, and neither can be read from inside it.
 */
async function terminalBinaries() {
  const root = join(unpacked, 'node-pty', 'prebuilds')
  if (!existsSync(root)) return []
  const platforms = await readdir(root)
  const found = []
  for (const name of platforms) {
    for (const file of await readdir(join(root, name))) {
      const path = join(root, name, file)
      const info = await stat(path)
      found.push({ platform: name, file, executable: (info.mode & 0o111) !== 0 })
    }
  }
  return found
}

/** The PE certificate table's size: 0 means the executable carries no signature. */
async function peCertificateSize(path) {
  const bytes = await readFile(path)
  const header = bytes.readUInt32LE(0x3c)
  const directories = header + 24 + (bytes.readUInt16LE(header + 24) === 0x20b ? 112 : 96)
  return bytes.readUInt32LE(directories + 4 * 8 + 4)
}

const results = []
const record = (label, value, pass) => results.push([label, typeof value === 'string' ? value : JSON.stringify(value), Boolean(pass)])

let server
let profile
let home
let child
try {
  if (!existsSync(binary)) throw new Error(`No app at ${appPath}. Build it first (npm run build:mac / build:win / build:linux).`)

  if (platform !== 'darwin') {
    const format = (await run('file', ['-b', binary])).stdout.trim()
    record(
      `${platform === 'win32' ? 'Windows' : 'Linux'} executable format`,
      format,
      platform === 'win32' ? format.startsWith('PE32+') && format.includes('x86-64') : format.startsWith('ELF 64-bit') && format.includes('x86-64')
    )
    const fuses = await readFuses(binary)
    record('fuses are flipped as configured', fuses, JSON.stringify(fuses) === JSON.stringify(EXPECTED_FUSES))
    const natives = await keyringBinaries()
    const own = platform === 'win32' ? 'keyring-win32-x64-msvc' : 'keyring-linux-x64-gnu'
    record(
      "only this platform's keychain binary is bundled, in the right format",
      natives,
      natives.length === 1 && natives[0].name === own && (platform === 'win32' ? natives[0].format.startsWith('PE32+') : natives[0].format.startsWith('ELF 64-bit'))
    )
    record(
      "ssh2's Node-only native crypto is not shipped",
      '',
      !existsSync(join(unpacked, 'ssh2', 'lib', 'protocol', 'crypto', 'build')) && !existsSync(join(unpacked, 'cpu-features', 'build'))
    )
    const terminalFiles = await terminalBinaries()
    record(
      "the terminal's binaries are unpacked for this platform only",
      terminalFiles,
      terminalFiles.length > 0 && terminalFiles.every((file) => file.platform.startsWith(platform === 'win32' ? 'win32-' : 'linux-'))
    )
    if (platform === 'win32') {
      const size = await peCertificateSize(binary)
      record('not code-signed (no certificate is configured)', `certificate table: ${size} bytes`, size === 0)
    }
    record(`launch checks skipped: a ${platform} build can't run on macOS`, '', true)
  } else {
    // ------------------------------------------------------------- static checks ---

    const archs = (await run('lipo', ['-archs', binary])).stdout.trim()
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    record('binary architecture', archs, archs.length > 0)

    const signature = (await run('codesign', ['-dv', appPath]).catch((error) => error)).stderr ?? ''
    record(
      'ad-hoc signature with hardened runtime, no team identity',
      signature.split('\n').filter((line) => /Signature=|flags=|TeamIdentifier=/.test(line)),
      signature.includes('Signature=adhoc') && /flags=0x\w+\(.*runtime.*\)/.test(signature) && signature.includes('TeamIdentifier=not set')
    )
    const verified = await run('codesign', ['--verify', '--deep', '--strict', appPath]).then(() => true, (error) => error.stderr)
    record('signature verifies (deep, strict)', verified, verified === true)

    const actualFuses = await readFuses(appPath)
    record('fuses are flipped as configured', actualFuses, JSON.stringify(actualFuses) === JSON.stringify(EXPECTED_FUSES))

    const natives = await keyringBinaries()
    const keyringPackages = natives.map((native) => native.name)
    const nativeArchs = natives.map((native) => `${native.name}: ${native.format}`)
    const wantedNative = archs.split(' ').map((arch) => (arch === 'arm64' ? 'keyring-darwin-arm64' : 'keyring-darwin-x64'))
    record(
      "the keychain module's binary for this build's CPU is unpacked, and no other platform's",
      nativeArchs,
      wantedNative.every((name) => keyringPackages.includes(name)) && keyringPackages.every((name) => name.startsWith('keyring-darwin-'))
    )
    record(
      "ssh2's Node-only native crypto is not shipped",
      '',
      !existsSync(join(unpacked, 'ssh2', 'lib', 'protocol', 'crypto', 'build')) && !existsSync(join(unpacked, 'cpu-features', 'build'))
    )

    const terminalFiles = await terminalBinaries()
    const helper = terminalFiles.find((file) => file.file === 'spawn-helper')
    const signedHelper =
      helper === undefined
        ? 'missing'
        : await run('codesign', ['--verify', join(unpacked, 'node-pty', 'prebuilds', helper.platform, 'spawn-helper')]).then(() => 'signed', () => 'unsigned')
    record(
      "the terminal's binaries are unpacked for this platform only, runnable and signed",
      { files: terminalFiles, signedHelper },
      terminalFiles.length > 0 &&
        terminalFiles.every((file) => file.platform.startsWith('darwin-')) &&
        terminalFiles.some((file) => file.file === 'pty.node') &&
        helper?.executable === true &&
        signedHelper === 'signed'
    )

    if (!archs.split(' ').includes(hostArch)) {
      record(`launch checks skipped: this ${hostArch} Mac can't run a ${archs} build`, '', true)
    } else {
      // ------------------------------------------------------------- fuses in effect ---

      const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, ...inherited } = process.env
      profile = await mkdtemp(join(tmpdir(), 'fly-package-profile-'))
      const asNode = spawn(binary, ['-e', 'process.stdout.write("RAN-AS-NODE")', `--user-data-dir=${profile}`, `--inspect=${INSPECT_PORT}`], {
        env: { ...inherited, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=/nonexistent-preload.js' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let asNodeOutput = ''
      asNode.stdout.on('data', (data) => (asNodeOutput += data))
      await sleep(4000)
      const inspector = await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`).then(() => 'listening', () => 'closed')
      asNode.kill('SIGKILL')
      record(
        'ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect are ignored by the shipped app',
        { output: asNodeOutput.slice(0, 80), inspector },
        !asNodeOutput.includes('RAN-AS-NODE') && inspector === 'closed'
      )
      await rm(profile, { recursive: true, force: true })

      // ------------------------------------------------------------------ launched ---

      server = await startSftpServer('package')
      await server.buildFixture()
      profile = await mkdtemp(join(tmpdir(), 'fly-package-profile-'))
      home = await mkdtemp(join(tmpdir(), 'fly-package-home-'))
      child = spawn(binary, [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`], { env: inherited, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = new Promise((resolve) => child.once('exit', resolve))

      let page
      for (let i = 0; i < 80 && !page; i++) {
        page = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
          .then((response) => response.json())
          .then((targets) => targets.find((target) => target.type === 'page' && !target.url.includes('splash.html')))
          .catch(() => undefined)
        if (!page) await sleep(250)
      }
      if (!page) throw new Error('The packaged app showed no window')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve) => ws.addEventListener('open', resolve))
      let nextId = 0
      const pending = new Map()
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      })
      const js = (expression) =>
        new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, (message) => (message.result?.exceptionDetails ? reject(new Error(message.result.exceptionDetails.exception?.description)) : resolve(message.result?.result?.value)))
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
        })
      const waitFor = async (expression, ms = 10000) => {
        for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(150)) if (await js(expression).catch(() => false)) return true
        return false
      }

      const rendered = await waitFor(`document.querySelector('[aria-label="Local files"] [role="grid"]') !== null`)
      const href = await js('location.href')
      record('the UI loads from inside app.asar', href, rendered && href.includes('/Contents/Resources/app.asar/out/renderer/index.html'))
      record(
        'the preload bridge exposes exactly the approved areas',
        await js('JSON.stringify(Object.keys(window.api).sort())'),
        (await js('JSON.stringify(Object.keys(window.api).sort())')) ===
          JSON.stringify(['app', 'connections', 'files', 'keys', 'local', 'sftp', 'sshConfig', 'system', 'terminals', 'transfers'])
      )
      // A terminal in the packaged app: this is what catches a helper left inside
      // the asar, or one the signature or the permission bits broke.
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)))
          ws.send(JSON.stringify({ id, method, params }))
        })
      const LOCAL_PANE = '[aria-label="Local files"]'
      await js(`document.querySelector('${LOCAL_PANE} [data-testid="tab-terminal"]').click()`)
      const terminalShown = await waitFor(`document.querySelector('${LOCAL_PANE} .xterm-rows') !== null`)
      const terminalText = `(document.querySelector('${LOCAL_PANE} .xterm-rows')?.innerText ?? '')`
      const promptShown = await waitFor(`${terminalText}.trim().length > 0`, 15000)
      await js(`document.querySelector('${LOCAL_PANE} .xterm-helper-textarea').focus()`)
      await send('Input.insertText', { text: 'echo PACKAGED-TERMINAL-$((6*7))' })
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      const terminalRan = await waitFor(`${terminalText}.includes('PACKAGED-TERMINAL-42')`, 20000)
      record('runs a local terminal, with its pty binary and helper from outside the asar', { terminalShown, promptShown, terminalRan }, terminalShown && promptShown && terminalRan)
      await js(`document.querySelector('${LOCAL_PANE} [data-testid="tab-files"]').click()`)

      const violations = await js(`new Promise((resolve) => {
        const seen = []
        document.addEventListener('securitypolicyviolation', (event) => seen.push(event.violatedDirective))
        window.__inline = 'blocked'
        const script = document.createElement('script')
        script.textContent = "window.__inline = 'ran'"
        document.head.appendChild(script)
        fetch('https://example.org/').catch(() => {})
        setTimeout(() => resolve(JSON.stringify({ seen, inline: window.__inline })), 800)
      })`)
      record(
        'the production Content-Security-Policy blocks inline scripts and outside connections',
        violations,
        JSON.parse(violations).inline === 'blocked' && JSON.parse(violations).seen.includes('script-src-elem') && JSON.parse(violations).seen.includes('connect-src')
      )
      record('the app is packaged and reports its versions', await js('window.api.system.getVersion().then(JSON.stringify)'), (await js('window.api.system.getVersion().then((v) => v.electron)')) === '44.0.0')

      const request = { name: 'package check', host: server.host, port: server.port, username: server.username, auth: { type: 'password' } }
      const first = await js(`window.api.connections.connectUnsaved(${q(request)}, { value: ${q(server.password)}, remember: false })`)
      const outcome = first?.status === 'host-key-unknown' ? await js(`window.api.sftp.trustHostKeyAndConnect(${q(first.token)})`) : first
      const listing = await js(`window.api.sftp.listDirectory(${q(outcome?.connection?.id)}, '/config/fixture').then((l) => l.entries.map((e) => e.name).sort())`)
      record('connects over SSH from inside the asar and lists a server folder', listing, outcome?.status === 'connected' && listing?.includes('alpha'))

      const data = Buffer.from(`packaged upload ${Date.now()}`)
      await writeFile(join(home, 'packaged.txt'), data)
      await js(`window.api.transfers.start(${q({ connectionId: outcome.connection.id, direction: 'upload', sourcePaths: [join(home, 'packaged.txt')], destinationDirectory: '/config', onConflict: 'replace' })})`)
      const uploaded = await waitFor(`window.api.transfers.list().then((jobs) => jobs.some((job) => job.status === 'completed'))`, 20000)
      const remoteSha = (await server.exec('sha256sum /config/packaged.txt')).split(' ')[0]
      record('uploads through the transfer queue, intact', { uploaded }, uploaded && remoteSha === createHash('sha256').update(data).digest('hex'))
      record('keeps its data in the given profile', await readdir(profile).then((names) => names.includes('known-hosts.json')), await readdir(profile).then((names) => names.includes('known-hosts.json')))

      ws.close()
      child.kill('SIGTERM')
      record('quits promptly when asked', '', await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))
    }
  }
} catch (error) {
  record('FATAL', error.stack ?? error.message, false)
} finally {
  try {
    child?.kill('SIGKILL')
  } catch {}
  await server?.remove()
  for (const dir of [profile, home]) if (dir) await rm(dir, { recursive: true, force: true })
}

for (const [label, value, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  [${label}]\n  ${value.slice(0, 300)}`)
const failed = results.filter(([, , pass]) => !pass)
console.log(`\n${results.length - failed.length}/${results.length} package checks passed${failed.length ? `: ${failed.map(([label]) => label).join(', ')}` : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
