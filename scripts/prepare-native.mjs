// Fetches @napi-rs/keyring's prebuilt binary for every packaging target, so a
// DMG, installer or AppImage built on this machine carries the right one
// (Milestone 10 plan D1). npm only installs the host's optional dependency.
//
//   node scripts/prepare-native.mjs            all targets below
//   node scripts/prepare-native.mjs darwin     just macOS (arm64 + x64)
//
// Installs with --no-save: package.json and the lockfile are untouched, and a
// later `npm install` removes the extra packages again.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TARGETS = {
  darwin: ['darwin-arm64', 'darwin-x64'],
  win32: ['win32-x64-msvc'],
  linux: ['linux-x64-gnu']
}

const { version } = JSON.parse(readFileSync(new URL('../node_modules/@napi-rs/keyring/package.json', import.meta.url), 'utf8'))
const platforms = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(TARGETS)
const packages = platforms.flatMap((platform) => {
  const targets = TARGETS[platform]
  if (targets === undefined) throw new Error(`Unknown platform "${platform}". Use one of: ${Object.keys(TARGETS).join(', ')}`)
  return targets.map((target) => `@napi-rs/keyring-${target}@${version}`)
})

console.log(`Installing ${packages.join(', ')}`)
// --force: npm otherwise refuses packages built for another OS or CPU.
execFileSync('npm', ['install', '--no-save', '--force', '--ignore-scripts', '--no-audit', '--no-fund', ...packages], { stdio: 'inherit' })
