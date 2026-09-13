// Runs electron-vite (dev or preview) with Electron presented as FileFly on macOS.
//
// macOS names a running app in the Dock and the menu bar after its bundle, and
// unpackaged runs use node_modules' Electron.app, so they read "Electron". This
// keeps a copy named FileFly, with the app icon, in node_modules/.cache and
// points electron-vite at it (ELECTRON_EXEC_PATH). The original Electron.app,
// which the smoke and integration tests launch, is left as it is.
//
//   node scripts/electron-vite.mjs dev|preview [electron-vite options]
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'FileFly'
const BUNDLE_ID = 'com.titansoft.fly.dev'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args) {
  execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

/** Returns the FileFly copy's executable, making the copy first if Electron or the icon changed. */
function fileFlyElectron() {
  const electronDir = dirname(require.resolve('electron'))
  const source = join(electronDir, 'dist', 'Electron.app')
  const icon = join(root, 'resources', 'icon.png')
  const folder = join(root, 'node_modules', '.cache', 'filefly-dev')
  const app = join(folder, `${NAME}.app`)
  const executable = join(app, 'Contents', 'MacOS', 'Electron')
  const stampFile = join(folder, 'stamp')
  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'))
  const stamp = `${version} ${createHash('sha256').update(readFileSync(icon)).digest('hex')}`

  if (existsSync(executable) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return executable

  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  try {
    run('cp', ['-Rc', source, app]) // an APFS clone: no extra disk space
  } catch {
    rmSync(app, { recursive: true, force: true })
    run('cp', ['-R', source, app])
  }

  const iconset = join(mkdtempSync(join(tmpdir(), 'filefly-icon-')), `${NAME}.iconset`)
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), icon, '--out', join(iconset, `icon_${size}x${size}.png`)])
    run('sips', ['-z', String(size * 2), String(size * 2), icon, '--out', join(iconset, `icon_${size}x${size}@2x.png`)])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents', 'Resources', 'filefly.icns')])
  rmSync(dirname(iconset), { recursive: true, force: true })

  const plist = join(app, 'Contents', 'Info.plist')
  for (const [key, value] of [['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BUNDLE_ID], ['CFBundleIconFile', 'filefly.icns']]) {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
  }
  // Apple Silicon only runs signed code, and editing Info.plist breaks a bundle's signature.
  try {
    run('codesign', ['--verify', source])
    run('codesign', ['--force', '--deep', '--sign', '-', app])
  } catch {
    // The stock Electron.app is unsigned (as on Intel), so its copy needs no signature either.
  }
  // Tell Launch Services the name and icon changed, or the Dock can keep showing the old ones.
  try {
    run(LSREGISTER, ['-f', app])
  } catch {
    // Launch Services registers the copy when it first opens anyway.
  }

  writeFileSync(stampFile, stamp)
  return executable
}

const env = { ...process.env }
if (process.platform === 'darwin' && env.ELECTRON_EXEC_PATH === undefined) {
  try {
    env.ELECTRON_EXEC_PATH = fileFlyElectron()
  } catch (error) {
    console.warn(`Could not prepare the ${NAME} copy of Electron, so the Dock will say "Electron": ${error.message}`)
  }
}

const child = spawn(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
