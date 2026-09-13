# Fly — Cross-Platform Desktop SFTP Client

Dual-pane file manager over SSH/SFTP. Electron + React + TypeScript + Vite + Tailwind.
Targets macOS (primary), Windows, Linux.

## Read these first

| File | What it is |
|---|---|
| `docs/PLAN.md` | **Authoritative spec.** 24 sections, 10 milestones. Requirements — do not redesign against it. |
| `docs/STATUS.md` | **Session handoff.** Where work stopped, exact resume commands. |
| `docs/README.md` | Milestone tracker + superseded decisions. |
| `docs/MILESTONE-3-PLAN.md` | Latest milestone plan: library evaluation, host-key trust, error model, test server. |

`docs/` is git-ignored on purpose — local planning only.

## Current state

**Milestones 1–3 ✅ done — runtime-verified and committed on `main`.**

Two panes: local files on the left; on the right a quick-connect form (password
auth) that becomes a remote file browser. Host keys are trusted on first use and
a changed key is refused. Verified by `npm test` (163 unit), `npm run
test:integration` (19 against real OpenSSH) and `npm run smoke` (36 checks
driving the real app).

Next: **Milestone 4 (SSH Key Authentication)** — not started. Plan it before
writing code. It becomes the §8 Connection Manager: saved profiles, private keys
+ passphrases, secrets in the OS keychain (§9), and a one-way `~/.ssh/config`
import resolved with `ssh -G` (decided — see MILESTONE-3-PLAN.md D11).

## Environment constraints — do not "fix" these

1. **`nvm use` before `npm install`.** Node 22.4.0 is the machine default and
   silently fails to install Electron; `.nvmrc` pins v24.14.1.
2. **Vite is pinned to 7.** `@vitejs/plugin-react` v6 requires Vite 8, but
   `electron-vite` v5 peers on Vite ≤ 7. Working set: `vite@^7.3.6` +
   `@vitejs/plugin-react@^5.0.4`. `npm update` will break the install with ERESOLVE.
   Vitest 5 peers on Vite `^6.4 || ^7 || ^8`, so it is compatible with the pin.
3. **TypeScript 7 removed `baseUrl`** (`TS5102`). Path aliases must be relative to
   the tsconfig: `"@shared/*": ["./src/shared/*"]`.
4. **This is a genuine Intel Mac** (i7-8559U), not Apple Silicon. The spec
   prioritises arm64 for release 1; an arm64 DMG can be cross-built here but
   **cannot be launched or tested locally**.
5. **Integration and smoke tests need the Colima VM: `colima start fly`** (it does
   not start at login). Docker CLI is a static binary at `/usr/local/bin/docker`
   — Homebrew has no Intel bottle for it. Test image is pinned:
   `linuxserver/openssh-server:10.3_p1-r1-ls236`.

## Electron gotcha: `ELECTRON_RUN_AS_NODE`

Editors that are themselves Electron apps (Claude Code, VS Code) export
`ELECTRON_RUN_AS_NODE=1` into the terminal. With it set, Electron **runs
`main.js` as a plain Node script and never opens a window**, and
`electron --version` prints the *bundled Node* version (`v24.18.1`) rather than
`v44.0.0` — indistinguishable from a corrupt binary at a glance.

`scripts/smoke-test.mjs` strips it from the child env. For a manual launch:

```bash
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE npm run dev
```

## macOS shell gotchas (these have already caused a false "all clean")

- **BSD `sed` does not support `\b`.** `s/\bfoo\b/bar/g` silently matches nothing.
  Use plain patterns or `[[:<:]]`/`[[:>:]]`.
- **`grep` is a shell function here, not `/usr/bin/grep`,** and has returned zero
  results for recursive searches with multiple `--exclude-dir` flags. For any sweep
  that matters, verify with:
  `find . -type f -not -path "./node_modules/*" -print0 | xargs -0 grep -Fn "term"`

## Testing gotchas (each cost a debugging round in M3)

- **`ssh2` can emit `error` twice for one connection** (handshake timeout, then
  "Connection lost before handshake"). A `once('error')` listener crashes the main
  process on the second. Listeners stay attached for the client's lifetime.
- **SFTP returns status 2 for a file listed as a folder**, same as a missing path —
  `stat` to tell them apart.
- **`ssh2` 1.17 has no post-quantum key exchange**; an ML-KEM-only server fails
  with `HANDSHAKE_FAILED` (that is how the test for it works).
- **Docker's port forwarder accepts then closes** while a container starts: probe
  for the `SSH-2.0` banner, and treat `close` as "not ready".
- **`pkill -f pattern` inside `sh -c` matches its own shell** — use `'[s]shd-session'`.
- **Electron's CDP has no window-bounds commands**; use `Emulation.setDeviceMetricsOverride`.
- **In `npm run dev` the detached DevTools window takes OS focus**, so CDP
  `Input.insertText` types nowhere. Real typing is tested against the built app
  (`npm run smoke`), which opens no DevTools.

## Commands

```bash
npm run dev               # Electron + Vite, hot reload
npm run build             # typecheck, then build main/preload/renderer
npm run typecheck         # both TS projects
npm test                  # Vitest unit tests (src/**/*.test.ts)
npm run test:integration  # against real OpenSSH in a container (needs Colima)
npm run smoke             # CDP end-to-end test on the BUILT app (build first; needs Colima)
                          # exits 1 on any failed check — extend it as milestones land
                          # SMOKE_SCREENSHOT_DIR=<dir> also saves screenshots
npm run test-server -- up # a local OpenSSH server for trying the app by hand (also: status, down)
npm run build:mac         # package .dmg (arm64 + x64)
```

## Architecture

```
Renderer (React, sandboxed)  ──contextBridge + IPC──>  Main (app logic, fs, SSH/SFTP)
                             <──── IPC_EVENTS ──────   (e.g. sftp:connection-closed)
```

```
src/
├── main/       main.ts · security.ts · logger.ts · errors.ts
│   ├── ipc/        validated handlers (one file per area)
│   ├── services/   local-files · connection (owns every remote connection)
│   └── sftp/       SftpProvider interface · ssh2 implementation · host-key trust store
├── preload/    the ONLY bridge — hand-written, per-method
├── renderer/   React app (components/ pages/ hooks/ services/)
└── shared/     types + IPC channel constants used by both sides
test/support/   container helper shared by integration tests, smoke and test-server
```

### Non-negotiables (spec sections 20, 23)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **`ipcRenderer` is never exposed.** Every method in `preload.ts` is written by
  hand, so the renderer cannot invoke an arbitrary channel. Event subscriptions
  pass the listener **payload only** (never Electron's event) and return an
  unsubscribe function.
- **Never expose `fs`, `child_process`, or `process` to React.** The renderer
  requests operations; main performs them.
- **Validate every IPC input** — treat renderer input as untrusted. Use the
  helpers in `src/main/ipc/validate.ts`; rebuild request objects field by field.
- **The renderer never builds a path.** Main returns absolute paths on every
  `FileEntry` plus `parentPath`; remote paths are always POSIX (`path.posix`).
- **Errors cross IPC as a `{code, message}` JSON envelope** thrown by
  `ipc/handle.ts`, unwrapped by `renderer/services/errors.ts`. Throw `AppError`
  (`src/main/errors.ts`) for user-actionable failures; `fromFsError` /
  `fromConnectError` / `fromSftpError` map library errors. Stack traces stay in
  main and go only to the log.
- **Never log credentials.** `logger.ts` redacts keys matching
  password/passphrase/privateKey/secret/token — and the smoke test fails if the
  test password appears anywhere in the main-process output.
- **Host keys are always verified.** Unknown keys are refused during the
  handshake and only trusted after the user confirms; a changed key is a hard
  stop with no "connect anyway". Never pass a `hostVerifier` that returns `true`.
- **Keep SFTP behind the `SftpProvider` abstraction** (spec section 7). Do not
  couple the app to one library.
- Avoid `any`. Small, focused modules.

### Decisions taken — do not re-litigate

- **electron-vite** over Electron Forge: its layout already matches the spec's
  main/preload/renderer split.
- **`sandbox: true`** forces a CJS preload, which is why `package.json` has no
  `"type": "module"`.
- **One `FileEntry` type for local and remote** (`src/shared/types/files.ts`).
- **Vitest** for unit tests, not `node:test`: Node's type stripping can't
  resolve this codebase's extensionless imports or path aliases.
- **`ssh2` directly**, not `ssh2-sftp-client` (a wrapper over it whose README
  advises against concurrent operations and whose types lag three majors).
- **Trust on first use via probe-then-reconnect:** the first connection refuses
  the unknown key; main holds the key + request under a single-use token
  (2-minute timer); confirming stores exactly that key and reconnects requiring it.
- **Quick connect in M3, Connection Manager in M4** (profiles and keychain together).
- **`~/.ssh/config`: one-way import in M4**, resolved with `ssh -G`.
- **Test server: Colima + OpenSSH container**, not Docker Desktop (GUI admin
  prompt, licence terms), not macOS Remote Login, not an in-process fake.
- **CSP is production-only** — the Vite dev server needs inline styles and a
  websocket; locking those down would break `npm run dev` without making the
  shipped app safer.

## Working agreement (spec section 24)

Work **one milestone at a time**: explain the plan → implement → **run the app** →
fix errors → verify → commit → only then move on. Do not batch milestones and do
not skip the run/verify step. Update the tracker in `docs/README.md` and the
handoff in `docs/STATUS.md` as state changes.
