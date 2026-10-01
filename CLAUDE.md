# Fly — Cross-Platform Desktop SFTP Client

Dual-pane file manager over SSH/SFTP. Electron + React + TypeScript + Vite + Tailwind.
Targets macOS (primary), Windows, Linux.

## Read these first

| File | What it is |
|---|---|
| `docs/PLAN.md` | **Authoritative spec.** 24 sections, 10 milestones. Requirements — do not redesign against it. |
| `docs/STATUS.md` | **Session handoff.** Where work stopped, exact resume commands. |
| `docs/README.md` | Milestone tracker + superseded decisions. |
| `docs/MILESTONE-3-PLAN.md` | M3 plan: SSH library evaluation, host-key trust, error model, test server. |
| `docs/MILESTONE-4-PLAN.md` | M4 plan: keychain storage, private keys, Connection Manager, `~/.ssh/config` import. |
| `docs/MILESTONE-5-PLAN.md` | M5 plan: active pane, application menu, splitter, independence tests. |
| `docs/MILESTONE-6-PLAN.md` | M6 plan: transfers — throughput research, safe writes, cancel, conflicts. |
| `docs/MILESTONE-7-PLAN.md` | M7 plan: transfer queue — planning, folders, concurrency, retry, multi-select. |
| `docs/MILESTONE-8-PLAN.md` | M8 plan: file operations — create folder, rename, delete (Trash locally), guard rails. |
| `docs/MILESTONE-9-PLAN.md` | M9 plan: drag and drop between panes, navigation hardening. |
| `docs/MILESTONE-10-PLAN.md` | M10 plan: packaging — DMGs, Windows/Linux cross-builds, fuses, verification. |
| `docs/MILESTONE-11-PLAN.md` | Latest milestone plan: terminals — a shell in each pane, flow control, node-pty packaging. |

`docs/` is git-ignored on purpose — local planning only.

## Current state

**All 10 milestones ✅ done — runtime-verified and committed on `main`.**

Two independent panes (Local | Remote) with a resizable, remembered divider, an
active pane (follows focus; Tab from a list switches), per-pane footers, and a
real application menu (Refresh `Cmd+R`, Focus panes `Cmd+1/2`, Go Back `Cmd+[`,
Parent `Cmd+↑`) that replaces Electron's default. Remote side: saved connections,
password or key login, secrets in the OS keychain, `~/.ssh/config` import,
host keys trusted on first use. Transfers (M6–M7): multi-select (Cmd/Shift-click,
`Cmd+A`) files and folders, then Upload / Download / `Cmd+T`. A request is planned
in main (conflicts asked once: Replace merges folders / Keep both / Skip), folders
are created, and one job per file runs in a queue, 3 at a time, with safe writes
(hidden temporary name → size check → atomic rename). Transfers panel: progress,
speed, Cancel, Retry (rebinds to a reconnected server), Completed/Failed filters.
File operations (M8): New Folder (toolbar, `Cmd/Ctrl+Shift+N`), Rename (`F2`), Delete
(`Delete`, `Cmd+Backspace` on macOS) — local deletes go to the Trash, remote ones
are permanent and never follow links; home, root and ancestors are refused in main.
Drag and drop (M9): drag rows (the selection) onto the other pane's listing or a
folder row; it becomes an ordinary queued transfer. Same-pane and external drags
are refused; navigation is limited to the app's own page.
Packaging (M10): `npm run build:mac|win|linux` → `release/` (DMGs arm64 + x64,
NSIS x64, AppImage x64); ad-hoc signed only, fuses flipped, production CSP;
`npm run verify:package` checks a build and runs the x64 `.app` against a test
server. Asks before quitting/closing with active transfers.
After M10 (user requests, 2026-09-14): the product is named **FileBird**; a 6-second
animated start screen (`splash-window.ts`, `renderer/splash.html`) floats over other
apps, then restores the Dock icon and menu bar; a bird Dock icon; a plain click opens
a folder and right-click shows a native context menu; a folder being opened says so.
Terminals (M11, 2026-09-29): each pane has **Files / Terminal** tabs (`Cmd/Ctrl+\``).
The remote terminal is a second channel on the connection that is already open; the
local one is a real pty through `node-pty` (prebuilt, nothing compiled). Sessions
live in main (`src/main/terminal/`), output is batched and flow-controlled, and
terminal bytes are never logged.
Verified by `npm test` (438 unit), `npm run test:integration` (67: real OpenSSH,
Keychain, `ssh`), `npm run smoke` (132 checks driving the real app) and
`npm run verify:package` (17 checks on the packaged app).

Next: **the user's review** of M6–M10. Not done without their explicit go-ahead:
Developer ID signing/notarisation, publishing, importing their real
`~/.ssh/config`, connecting to their servers. Untested here: the arm64 build
(Intel Mac), Windows and Linux builds (cross-built, statically verified).
The user asked (2026-09-13) for M6–M10 to proceed without approval stops, using
Claude's own recommendations; each milestone still gets a plan in `docs/`,
verification and a commit.

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
   `linuxserver/openssh-server:10.3_p1-r1-ls236`. Tests also need the OpenSSH
   client tools (`ssh`, `ssh-keygen`, `ssh-keyscan`), present on macOS.
6. **`FLY_DEV_HOME`** (unpackaged builds only) overrides the folder Fly starts in
   and reads `~/.ssh/config` from. The smoke test uses it; **never override
   `HOME` instead** — macOS finds the login keychain through `HOME`.
   **`FLY_DEV_TRASH_DIR`** (unpackaged only) replaces the system Trash with a
   folder, so tests never put files in the user's real Trash.
   **`FLY_DEV_DOWNLOADS`** (unpackaged only, and only alongside `FLY_DEV_HOME`)
   is where downloads go, so tests never write to the real Downloads folder;
   without it an unpackaged run with `FLY_DEV_HOME` downloads into that fixture.
   Unpackaged runs keep app data in `…/Application Support/Fly (development)`
   unless `--user-data-dir` is given; the installed app uses its own folder.
7. **Keychain namespaces:** `Fly` (packaged), `Fly (development)` (`npm run dev`
   and smoke), `Fly (test <pid>)` (integration). Accounts are
   `connection/<uuid>/password|passphrase`.

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

## Testing gotchas added in M4

- **Never read a Fly secret's value from another program** (`security … -w`):
  macOS shows a Keychain access dialog and the call hangs. Check existence by
  attributes only (`security find-generic-password -s … -a …`, no `-w`); check
  values through Fly. To delete leftovers, run `@napi-rs/keyring` through the
  Electron binary (`ELECTRON_RUN_AS_NODE=1`) — the creator can delete silently.
- **Overriding `HOME` hides the login keychain** ("A default keychain could not
  be found"). Use `FLY_DEV_HOME`.
- **`ssh -G` executes `Match exec` commands**, and prints `IdentityFile` with
  `~`/`%h` unexpanded plus 7 default key names when none is configured.
- **`ssh2` reports a wrong passphrase like a server rejection** — keys are parsed
  locally first (`ssh/private-keys.ts`).
- **CDP text helpers must be parenthesised:** `el?.textContent ?? ''.includes(x)`
  binds `.includes` to `''` and always passes (this made some M3 smoke checks
  vacuous until fixed in M4).
- **After `Page.reload` over CDP, wait for a fresh document** — a check can
  match the old page before the reload lands.

## Testing gotchas added in M5

- **CDP key events never trigger native menu accelerators** (verified: neither
  Electron's default Reload nor a custom item fired). The smoke test launches the
  app with `--inspect` and clicks menu items by id through the **main-process
  Node inspector** (`Menu.getApplicationMenu().getMenuItemById('command:…').click()`).
  The physical key → menu path stays a manual check.
- **Electron's default menu** (used unless replaced) binds `Cmd+R` to Reload and
  ships `Toggle Developer Tools` — `src/main/menu.ts` replaces it; keep the
  `editMenu` role or copy/paste breaks in text fields on macOS.
- **CDP `Tab` does perform real focus traversal**, so Tab behaviour is testable.

## Testing gotchas added in M6

- **`ssh2`'s `fastGet`/`fastPut` never call back if the connection drops**: their
  error path waits for the server to confirm closing the remote handle over the
  dead channel. `withTransferChannel` races the work against the channel's
  `close` event (integration-tested, mutation-checked: without it the test hangs).
- **A relaunched Electron window is often not focused** (macOS doesn't activate
  an app launched from a background process, and `app.focus({ steal })` from it
  doesn't help). Unfocused, Chromium moves `activeElement` but fires no
  focus events, so anything driven by `onFocus` silently stops. The smoke test
  and dev checks call CDP `Emulation.setFocusEmulationEnabled`.
- **Backslashes vanish inside the smoke test's template-literal expressions**
  (`\/` becomes `/`), which turned a regex into a ReferenceError that `waitFor`
  swallowed. Prefer `.includes()` / `.endsWith()` there.
- **The Write tool turns a `\u0000` escape into a literal NUL byte**, and Bash
  refuses commands containing control characters. Build such strings with
  `String.fromCharCode(0)`.
- **Plain SFTP `rename` onto an existing file fails** (status 4) on OpenSSH; use
  `ext_openssh_rename` (`posix-rename@openssh.com`).

## Testing gotchas added in M7

- **Calling `app.quit()` from a microtask inside a prevented `before-quit`
  leaves the app running with no windows** — Electron is still inside the first
  quit, which then resets its quitting state. Re-quit from `setTimeout`. Smoke
  now records whether the app exits within 5 s.
- **Check for leftovers, not just results.** Upload checks that only looked for
  final names passed while `.fly-part` files piled up after drops and
  disconnects; the 960 px screenshot showed them. Smoke and integration now
  assert no `fly-part` names remain.
- **A dev app launched with `--inspect` absorbs the first SIGTERM** ("Debugger
  ending…"), and `pkill -f` patterns missed it once, so an orphaned app kept
  ports 9224/9340 and a later dev check silently drove the *old* app. Stop dev
  apps by PID (`lsof -t -iTCP:9224 -sTCP:LISTEN`) and confirm the port is free.
- **The Edit menu's `selectAll` role swallows `Cmd+A`** before the page sees it;
  Select All is a menu command that selects text in a focused field, else files.
- **CDP mouse events take `modifiers`** (1 Alt, 2 Ctrl, 4 Meta, 8 Shift) — that is
  how smoke Cmd-clicks and Shift-clicks rows.

## Testing gotchas added in M8

- **`registerAccelerator: false` only works on Windows and Linux.** On macOS a
  menu accelerator is always registered, so Delete… has none there (it would
  take `Cmd+Backspace` from text fields); the focused file list handles the key.
- **Keys typed in a dialog bubble to its React parent.** Pane dialogs render
  outside the pane's `<section>`, or Backspace in a rename field would go up a folder.
- **A mutation that changes nothing is not a test gap:** remote delete re-checks
  `lstat` at every level, so dropping one `isSymlink` test changed no behaviour.
  Mutate the realistic bug (`stat` instead of `lstat`) instead.

## Testing gotchas added in M9

- **Real drags over CDP:** `Input.setInterceptDrags`, press and move the mouse
  over a `draggable` row, wait for `Input.dragIntercepted` (it carries the data
  the page's `dragstart` set), then `Input.dispatchDragEvent` enter/over/drop
  with that data (`app.startDrag` in smoke). External file drops are
  `dispatchDragEvent` with `data.files`.
- **During `dragover` only `dataTransfer.types` are readable**, so the drag type
  name carries the source side (`application/x-fly-entries+local`).
- **A dropped file doesn't navigate** because Electron's `navigateOnDragDrop`
  defaults to false (probed); it's now pinned, and `will-navigate` only allows
  the app's own URL (it used to allow every `file:` URL).

## Testing gotchas added after M10

- **Native context menus can't be driven over CDP.** Smoke replaces
  `Menu.prototype.popup` through the main-process inspector on every launch: it
  records each menu's labels and clicks the item named by `app.contextMenu(selector, pick)`.
- **CDP `clickCount` sets `event.detail`**, so a double-click whose second click
  arrives after the new listing renders is testable (and was mutation-checked).
- **smoke's `selectRow` right-clicks folders**, since a plain click now opens them.
- **`aria-selected` is not only for rows** now that panes have tabs: checks that
  count the selection must ask for `[role="row"][aria-selected="true"]`.
- **Driving a terminal over CDP:** focus `.xterm-helper-textarea`, `Input.insertText`,
  then an Enter key event; read what it shows from `.xterm-rows` `innerText`.
- **ssh2's `setWindow` takes rows before columns** — the opposite of xterm's
  `resize(cols, rows)`. The integration test checks `stty size` after a resize.
- **node-pty needs no rebuild** (Node-API prebuilds), but its `spawn-helper` has no
  file extension, so `asarUnpack: '**/*.node'` alone leaves it inside the asar and
  every spawn fails in the packaged app only; `verify:package` checks it.
- **Counting IPC requests:** smoke wraps `ipcMain._invokeHandlers.get('sftp:list-directory')`
  (Electron-internal) through the inspector to count listings; the check fails loudly
  (`listCounter` ≠ `'counting'`) if an Electron upgrade renames it.

## Testing gotchas added in M10

- **Node won't let a process exit while a debugger is attached.** Quitting the
  app via the main-process inspector hangs until the CDP session closes; smoke's
  `app.quitFromMenu()` sends the quit, then detaches.
- **The test image declares `VOLUME /config`**, and `docker rm -f` keeps
  anonymous volumes: 107 of them (19 GB) had filled the Colima disk and made
  uploads fail with `TRANSFER_FAILED`. Container removal always passes `-v`.
- **`Runtime.evaluate` bypasses the page's CSP**, so `eval` "working" over CDP
  proves nothing; check `securitypolicyviolation` events instead (the production
  CSP header *does* apply to `file://` in Electron 44).
- **npm installs only the host's optional native package**; cross-builds need
  `scripts/prepare-native.mjs` first (`npm install --no-save --force …`). A later
  `npm install` removes those extra packages again.
- **electron-builder logs "signing with signtool.exe" on macOS even with no
  certificate** — nothing is signed (PE certificate table is 0 bytes; checked by
  `verify:package`).
- **Very long `python3 - <<'PY'` heredocs have hung the shell** (no Python process
  ever started); write the script to a file and run that instead.

## Commands

```bash
npm run dev               # Electron + Vite, hot reload
                          # (postinstall + every dev run call scripts/dev-app-name.mjs, which names node_modules'
                          #  Electron.app after the app and gives it the icon, so the Dock never says "Electron")
npm run build             # typecheck, then build main/preload/renderer
npm run typecheck         # both TS projects
npm test                  # Vitest unit tests (src/**/*.test.ts)
npm run test:integration  # against real OpenSSH in a container (needs Colima)
npm run smoke             # CDP (+ main-process inspector) end-to-end test on the BUILT app (build first; needs Colima)
                          # exits 1 on any failed check — extend it as milestones land
                          # SMOKE_SCREENSHOT_DIR=<dir> also saves screenshots
npm run test-server -- up # a local OpenSSH server for trying the app by hand (also: status, down)
npm run build:mac         # DMGs (arm64 + x64) → release/   (build:win → NSIS x64, build:linux → AppImage x64)
npm run verify:package -- release/mac/FileBird.app   # signature, fuses, natives + launch against a test server (also win-unpacked / linux-unpacked, static)
```

## Architecture

```
Renderer (React, sandboxed)  ──contextBridge + IPC──>  Main (app logic, fs, SSH/SFTP)
                             <──── IPC_EVENTS ──────   (e.g. sftp:connection-closed)
```

```
src/
├── main/       main.ts · menu.ts · security.ts · logger.ts · errors.ts
│   ├── ipc/        validated handlers (one file per area)
│   ├── services/   local-files · connection (live connections) · connection-profiles · ssh-config-import · file-operations (+ protected-paths)
│   ├── transfers/  queue (FIFO, 3 at a time, retry) · plan (conflicts, folder walk) · run-job (safe write) · sides (local/remote) · progress · names
│   ├── sftp/       SftpProvider interface · ssh2 implementation · host-key trust store
│   ├── ssh/        private-key reading/inspection · ~/.ssh/config scan + ssh -G resolution
│   ├── secrets/    SecretStore interface · OS keychain implementation (@napi-rs/keyring)
│   └── storage/    JsonDocument (atomic, 0600) · connections.json
│   ├── terminal/   shell sessions (local pty + SSH channel), output batching, flow control
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
- **Never log anything a terminal carries**, at any level: its output holds
  passwords, keys and whole environments (smoke-tested with typed markers).
- **Secrets live only in the OS keychain** (via `SecretStore`), are saved only
  after the server accepts them, and never reach `connections.json`, the log, or
  the renderer (smoke-tested, mutation-checked).
- **Private key files are read only in the main process**; the renderer gets a
  path from the native dialog and a `KeyInfo` summary, never key material.
- **The SSH config import never runs `ssh -G` on a config with `Match exec`
  until the user consents** (unit, integration and smoke tested).
- **Host keys are always verified.** Unknown keys are refused during the
  handshake and only trusted after the user confirms; a changed key is a hard
  stop with no "connect anyway". Never pass a `hostVerifier` that returns `true`.
- **Transfers never leave a partial file under the real name**: write to
  `.<name>.fly-part-<hex>` in the destination folder, check the size, then rename
  (remote: `posix-rename`). A failed or cancelled job removes its temporary file;
  one it couldn't remove (connection gone) is removed before its retry, and
  disconnect/quit wait (≤ 5 s) for cancelled jobs to clean up. Nothing existing
  is overwritten unless the user chose Replace; Replace merges folders and never
  deletes anything or swaps a file for a folder. A destination that appears after
  queueing fails the job (`ALREADY_EXISTS`).
- **Deletes are guarded in main:** never the filesystem root, the home folder
  (local `appHome` / the connection's remote home) or any folder containing it;
  remote deletes use `lstat` and never follow links; local deletes go to the
  Trash with **no permanent-delete fallback**. Renames never replace an existing
  item. Names are checked with `src/shared/names.ts` on both sides.
- **Keep SFTP behind the `SftpProvider` abstraction** (spec section 7). Do not
  couple the app to one library.
- Avoid `any`. Small, focused modules.

### Decisions taken — do not re-litigate

- **The product is called FileBird** (user request, 2026-09-14): `APP_NAME` in
  `src/shared/constants/app.ts` for every name shown in code, plus `productName` in
  `electron-builder.yml`, the page `<title>`, README and the DMG's install notes.
  **Internal identifiers keep "fly" on purpose**: app id `com.titansoft.fly`, the
  installed app's data folder `fly` (pinned in `userDataFolder`, since `app.setName`
  would otherwise move it), keychain namespaces `Fly` / `Fly (development)`,
  `.fly-part-` temp names, drag types and `fly.layout.v1`.

- **electron-vite** over Electron Forge: its layout already matches the spec's
  main/preload/renderer split.
- **`sandbox: true`** forces a CJS preload, which is why `package.json` has no
  `"type": "module"`.
- **Navigation** is limited to the dev server origin, or exactly the packaged
  `index.html` (`src/main/navigation.ts`); `navigateOnDragDrop: false` is pinned.
- **Drag and drop:** between panes it is an ordinary queued transfer (M9); within
  one pane, dropping on a folder row **moves** the items there (user request,
  2026-10-02) — a rename, so it never copies and never overwrites, refuses a
  folder into itself, and leaves items already in that folder alone. A move
  across disks is refused with a message (it would need a copy). Still no drops
  from Finder/Explorer (would need `webUtils.getPathForFile` + review).
  **`effectAllowed` is `copyMove`**: a drop whose effect the drag didn't allow
  never fires at all, which is why a move silently did nothing at first.
- **One `FileEntry` type for local and remote** (`src/shared/types/files.ts`).
- **Vitest** for unit tests, not `node:test`: Node's type stripping can't
  resolve this codebase's extensionless imports or path aliases.
- **`ssh2` directly**, not `ssh2-sftp-client` (a wrapper over it whose README
  advises against concurrent operations and whose types lag three majors).
- **Trust on first use via probe-then-reconnect:** the first connection refuses
  the unknown key; main holds the key + request under a single-use token
  (2-minute timer); confirming stores exactly that key and reconnects requiring it.
- **Secret storage: `@napi-rs/keyring`** (one OS-store item per secret, as §9
  names), not Electron `safeStorage` (Linux can fall back to plaintext; Electron
  -only, so untestable in Vitest) and not archived `keytar`.
- **Connection Manager in M4:** passwords/passphrases are asked for at connect
  time (with "Remember"), not typed into the profile form. "Connect without
  saving" goes through `connections.connectUnsaved`; M3's `sftp.connect` is gone.
- **`~/.ssh/config`: one-way import**, hosts listed by Fly's parser, resolved with
  `ssh -F <config> -G -- <alias>`; hosts with warnings start unticked.
- **Deferred:** SSH agent login, trusting `~/.ssh/known_hosts`, ProxyJump,
  PKCS#8 conversion (the error gives the `ssh-keygen -p` fix), FIDO keys.
- **Test server: Colima + OpenSSH container**, not Docker Desktop (GUI admin
  prompt, licence terms), not macOS Remote Login, not an in-process fake.
- **Application menu replaces Electron's default** (M5): no Reload/DevTools in
  packaged builds; menu commands travel as `IPC_EVENTS.MENU_COMMAND` and act on the
  active pane. Accepted trade-off: `Cmd+↑` / `Cmd+[` belong to the menu app-wide.
- **Panes stay independent without React Context** (§16 evaluated at M5): state is
  lifted to `MainPage`, menu commands reach panes via `PaneHandle` refs. Revisit at
  M7 (the transfer queue spans both panes).
- **Divider position lives in renderer `localStorage`** (`fly.layout.v1`) until a
  settings file exists.
- **Transfers use `fastGet`/`fastPut`** (64 parallel 32 KB requests; 2–2.5× plain
  streams) **on a dedicated SFTP channel per transfer**; Cancel ends that channel.
  **No native crypto rebuild:** measured 70–87 MB/s either way through the port
  forward, matching OpenSSH; `aes128-gcm` runs 550+ MB/s in Electron's fallback.
  ChaCha20-only servers would fail (BoringSSL lacks it) — accepted.
- **The queue lives in main (M7):** a request is *planned* first (validate, stat,
  conflicts, folder walk ≤ 10,000 files / depth 64, create folders), then one job
  per file runs FIFO, **3 at a time**. Links to folders inside a transfer aren't
  followed; skipped items are reported, not failed. A lost connection fails its
  queued jobs too, so "Retry failed" restores everything; retry rebinds to a live
  connection to the same host/port/user. History is in memory (1,000 finished).
- **Still no React Context (M7 revisit):** the queue is a `useTransferQueue` hook in
  `MainPage`, batching updates per animation frame; panes get props.
- **File operations (M8) use small dialogs, not inline row editing.**
  Operations are passed to `FilePane` as a per-side `PaneOperations` object.
- **Clicks (user request, 2026-09-14, replacing spec §14's double-click):** a plain
  click opens a folder (clicks with `event.detail >= 2` are ignored, so a habitual
  double-click doesn't open the folder that lands under the pointer); Cmd/Shift-click
  select; **right-click selects the row and shows a native context menu** (Open,
  Upload/Download, New Folder, Rename…, Move to Trash…/Delete…, Refresh). The renderer
  sends action ids + enabled flags (`app.showContextMenu`); main owns the labels,
  validates the request and pops up `Menu`. Moving items is still not implemented.
- **Terminals (M11):** one shell per pane, as tabs beside the files. The remote
  shell is a channel on the live connection (`SftpProvider.openShell` → ssh2
  `client.shell`), so no second login; closing it ends that channel only, never
  the connection. Terminals are capped (3 per connection, 8 in all) because a
  server allows ~10 channels and transfers use up to four. The local shell is
  `node-pty`, loaded lazily in a try/catch so a missing binary disables only the
  terminal. Bytes cross the bridge (not text), batched every 5 ms, paused above
  100k unacknowledged characters and resumed below 5k. The folder is set once, at
  open; nothing is ever typed into a running shell. While a terminal has focus the
  menu's file commands are disabled, so their keys reach the shell
  (`TERMINAL_SUPPRESSED_COMMANDS`).
- **A download nobody aimed goes to the Downloads folder** (user request,
  2026-10-01), falling back to the home folder when there is none
  (`downloadDirectory`). The Download button, the context menu and `Cmd+T` use it,
  and the button's tooltip names it. **Dragging is how you choose somewhere else:**
  a drop on a folder row goes to that folder, a drop on a pane to the folder it
  shows. The local pane itself still opens in the home folder.
- **Each pane searches its own folder** (user request, 2026-10-01): a box in the
  toolbar (`Cmd/Ctrl+F`, or the magnifier) filters the listing by name as you
  type, case-insensitive, current folder only. Hidden rows leave the selection
  (`useDirectory` filters before pruning), so nothing invisible can be
  transferred or deleted. Enter hands the list back the keyboard with the first
  match selected, Escape clears, and opening another folder empties the search.
- **A finished transfer offers "Show"** (user request, 2026-10-01), which opens
  Finder / File Explorer at that file (`shell.showItemInFolder`), as a browser's
  downloads list does. Main refuses a path that is no longer there; the button
  names the file in its tooltip.
- **A folder being opened says so** (user request, 2026-09-14): `useDirectory.loadingPath`
  marks its row (`aria-busy`, spinner + "Opening…", shown after 150 ms via
  `.reveal-after-delay` so quick loads don't flash). Opening a folder whose listing is
  already in flight is ignored, since each new request discarded the one on its way.
- **CSP is production-only** — the Vite dev server needs inline styles and a
  websocket; locking those down would break `npm run dev` without making the
  shipped app safer. Verified enforced in the packaged app (M10).
- **Packaging (M10):** electron-builder, `npmRebuild: false` (ssh2 uses pure-JS
  crypto; `@napi-rs/keyring` is prebuilt per platform), `asarUnpack: **/*.node`,
  ssh2/cpu-features Node-ABI binaries excluded, per-platform keyring binaries
  only. **macOS ad-hoc signed** (`identity: '-'`, hardened runtime, default
  entitlements) — never a developer identity. **Fuses:** RunAsNode, NODE_OPTIONS
  and `--inspect` off; asar integrity, only-load-from-asar, cookie encryption on.
- **Quitting or closing the window with active transfers asks first**
  (`app-lifecycle.ts`); confirming uses the settle-then-quit path.

## Working agreement (spec section 24)

Work **one milestone at a time**: explain the plan → implement → **run the app** →
fix errors → verify → commit → only then move on. Do not batch milestones and do
not skip the run/verify step. Update the tracker in `docs/README.md` and the
handoff in `docs/STATUS.md` as state changes.
