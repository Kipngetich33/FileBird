# Fly — Cross-Platform Desktop SFTP Client

Dual-pane file manager over SSH/SFTP. Electron + React + TypeScript + Vite + Tailwind.
Targets macOS (primary), Windows, Linux.

## Read these first

| File | What it is |
|---|---|
| `docs/PLAN.md` | **Authoritative spec.** 24 sections, 10 milestones. Requirements — do not redesign against it. |
| `docs/STATUS.md` | **Session handoff.** Where work stopped, current blocker, exact resume commands. |
| `docs/README.md` | Milestone tracker + superseded decisions. |

`docs/` is git-ignored on purpose — local planning only.

## Current state

**Milestones 1 (Application Foundation) and 2 (Local File Browser): ✅ done —
runtime-verified and committed on `main`.**

The app opens a local file pane in the home folder: open / Back / parent /
refresh, keyboard navigation, Name · Type · Size · Modified, symlinks followed,
friendly errors. Verified by `npm test` (56 unit tests) and `npm run smoke`
(21 end-to-end checks against the real window, including real mouse and
keyboard input).

Next: **Milestone 3 (SFTP Connection)** — not started. Plan it before writing
code. It needs a library evaluation first (spec §7) and a local test SFTP
server (§19). See `docs/STATUS.md`.

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

## Commands

```bash
npm run dev        # Electron + Vite, hot reload
npm run build      # typecheck, then build main/preload/renderer
npm run typecheck  # both TS projects
npm test           # Vitest unit tests (src/**/*.test.ts)
npm run smoke      # CDP end-to-end test: drives the real app, checks the IPC chain
                   # exits 1 on any failed check — extend it as milestones land
npm run build:mac  # package .dmg (arm64 + x64)
```

## Architecture

```
Renderer (React, sandboxed)  ──contextBridge + IPC──>  Main (app logic, fs, SSH/SFTP)
```

```
src/
├── main/       main.ts · security.ts · logger.ts · errors.ts · ipc/ · services/
├── preload/    the ONLY bridge — hand-written, per-method
├── renderer/   React app (components/ pages/ hooks/ services/)
└── shared/     types + IPC channel constants used by both sides
```

### Non-negotiables (spec sections 20, 23)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **`ipcRenderer` is never exposed.** Every method in `preload.ts` is written by
  hand, so the renderer cannot invoke an arbitrary channel.
- **Never expose `fs`, `child_process`, or `process` to React.** The renderer
  requests operations; main performs them.
- **Validate every IPC input** — treat renderer input as untrusted. Use
  `assertString` / `assertAbsolutePath` from `src/main/ipc/validate.ts`.
- **The renderer never builds a path.** Main returns absolute paths on every
  `FileEntry` plus `parentPath`; the renderer only sends back paths it was given.
- **Errors cross IPC as a `{code, message}` JSON envelope** thrown by
  `ipc/handle.ts`, unwrapped by `renderer/services/errors.ts`. Throw `AppError`
  (`src/main/errors.ts`) for user-actionable failures; `fromFsError` maps errno. Stack traces stay in
  main and go only to the log.
- **Never log credentials.** `logger.ts` redacts keys matching
  password/passphrase/privateKey/secret/token.
- **Keep SFTP behind the `SftpProvider` abstraction** (spec section 7). Do not
  couple the app to one library.
- Avoid `any`. Small, focused modules.

### Decisions taken — do not re-litigate

- **electron-vite** over Electron Forge: its layout already matches the spec's
  main/preload/renderer split.
- **`sandbox: true`** forces a CJS preload, which is why `package.json` has no
  `"type": "module"`.
- **One `FileEntry` type for local and remote** (`src/shared/types/files.ts`).
  The SFTP provider maps into it so the pane is reused unchanged in Milestone 5.
- **Vitest** for unit tests, not `node:test`: Node's type stripping can't
  resolve this codebase's extensionless imports or path aliases.
- **CSP is production-only** — the Vite dev server needs inline styles and a
  websocket; locking those down would break `npm run dev` without making the
  shipped app safer.

## Working agreement (spec section 24)

Work **one milestone at a time**: explain the plan → implement → **run the app** →
fix errors → verify → commit → only then move on. Do not batch milestones and do
not skip the run/verify step. Update the tracker in `docs/README.md` and the
handoff in `docs/STATUS.md` as state changes.

## Open question for Milestone 3/4

`ssh2` does **not** read `~/.ssh/config` — no host aliases, no `IdentityFile`, no
`ProxyJump`. This machine has several keypairs and an existing config. Decide
whether the Connection Manager stores all metadata itself (what the spec implies)
or additionally imports from `~/.ssh/config` (a real ergonomic win, but not in the
spec). Raise before building Milestone 4.
