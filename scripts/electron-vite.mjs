// Runs electron-vite (dev or preview) with the app named after itself on macOS.
//
// macOS names a running app in the Dock and the menu bar after its bundle, and
// an unpackaged run uses node_modules' Electron.app. scripts/dev-app-name.mjs
// names that bundle after this app and gives it the icon; it also runs from
// `postinstall`, so any other way of starting the app (electron . by hand, or
// an editor task) shows the same name.
//
//   node scripts/electron-vite.mjs dev|preview [electron-vite options]
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nameDevelopmentApp } from './dev-app-name.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  nameDevelopmentApp()
} catch (error) {
  // A name is never worth failing a dev run for.
  console.warn(`Could not name the development app, so the Dock will say "Electron": ${error instanceof Error ? error.message : String(error)}`)
}

const child = spawn(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})
child.on('exit', (code) => process.exit(code ?? 1))
