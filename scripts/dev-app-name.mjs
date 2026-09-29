// Gives unpackaged runs the app's own name and icon on macOS.
//
// The Dock and the menu bar name a running app after its bundle, and an
// unpackaged run uses node_modules' Electron.app, so without this it reads
// "Electron" whichever way the app is started (npm start, npm run dev, or
// electron . by hand). This renames that bundle in place — its own metadata
// only — and gives it the app icon.
//
// It runs from `postinstall`, so a reinstall restores it, and again before
// every dev run. Elsewhere, and if anything goes wrong, it does nothing: the
// name is cosmetic and must never stop the app from starting.
//
//   node scripts/dev-app-name.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root0 = dirname(fileURLToPath(import.meta.url))
// The one place the name is written, read without importing TypeScript.
const APP_NAME = /APP_NAME = '([^']+)'/.exec(readFileSync(join(root0, '..', 'src', 'shared', 'constants', 'app.ts'), 'utf8'))?.[1] ?? 'FileBird'
const ICON_FILE = `${APP_NAME.toLowerCase()}.icns`
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const root = join(root0, '..')

const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

/** Renames Electron's development bundle after this app, and gives it the icon. */
export function nameDevelopmentApp() {
  if (process.platform !== 'darwin') return 'not macOS'

  const require = createRequire(import.meta.url)
  const electronDir = dirname(require.resolve('electron'))
  const bundle = join(electronDir, 'dist', 'Electron.app')
  const plist = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return 'no Electron bundle yet'

  const icon = join(root, 'resources', 'icon.png')
  const iconStamp = join(bundle, 'Contents', 'Resources', `${ICON_FILE}.stamp`)
  const wanted = createHash('sha256').update(readFileSync(icon)).digest('hex')
  const named = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleName', plist]) === APP_NAME
  const iconCurrent = existsSync(iconStamp) && readFileSync(iconStamp, 'utf8') === wanted
  if (named && iconCurrent) return 'already named'

  if (!iconCurrent) {
    const folder = mkdtempSync(join(tmpdir(), 'filebird-icon-'))
    const iconset = join(folder, `${APP_NAME}.iconset`)
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(size), String(size), icon, '--out', join(iconset, `icon_${size}x${size}.png`)])
      run('sips', ['-z', String(size * 2), String(size * 2), icon, '--out', join(iconset, `icon_${size}x${size}@2x.png`)])
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', join(bundle, 'Contents', 'Resources', ICON_FILE)])
    rmSync(folder, { recursive: true, force: true })
    writeFileSync(iconStamp, wanted)
  }

  for (const [key, value] of [
    ['CFBundleName', APP_NAME],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleIconFile', ICON_FILE]
  ]) {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
  }
  // Launch Services caches a bundle's name and icon; tell it they changed.
  try {
    run(LSREGISTER, ['-f', bundle])
  } catch {
    // It re-reads the bundle the next time the app opens anyway.
  }
  return `named ${APP_NAME}`
}

// Run directly (from postinstall); imported, only the function above is used.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`development app name: ${nameDevelopmentApp()}`)
  } catch (error) {
    // Never fail an install over a name.
    console.warn(`Could not name the development app, so the Dock will say "Electron": ${error instanceof Error ? error.message : String(error)}`)
  }
}
