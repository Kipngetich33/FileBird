# Fly

A cross-platform desktop SFTP client — dual-pane file management over SSH, built
with Electron, React and TypeScript.

Targets macOS (Apple Silicon first), Windows and Linux.

## Requirements

- **Node.js 22.12 or newer** (Electron's installer needs `require(esm)`).
  Run `nvm use` to pick up the pinned version in `.nvmrc`.

## Getting started

```bash
nvm use          # v24.14.1
npm install
npm run dev      # Electron + Vite with hot reload
```

### Test server

Integration and smoke tests run against OpenSSH in a throwaway container, bound
to `127.0.0.1` only. On macOS this uses [Colima](https://colima.run):

```bash
brew install colima
colima start fly --vm-type vz --cpu 2 --memory 2 --disk 20
# plus the Docker CLI (e.g. the static binary from download.docker.com)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development mode with hot reload |
| `npm run build` | Typecheck, then build main / preload / renderer |
| `npm run start` | Preview the production build |
| `npm run typecheck` | Typecheck both TS projects |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Tests against a real OpenSSH server in a container (needs Colima) |
| `npm run smoke` | End-to-end check: launches the built app and drives it over CDP (needs Colima) |
| `npm run test-server -- up` | Start a local OpenSSH server to try the app by hand (`status`, `down`) |
| `npm run build:mac` | Package a macOS `.dmg` (arm64 + x64) |
| `npm run build:win` | Package a Windows NSIS installer |
| `npm run build:linux` | Package a Linux AppImage |

## Architecture

```text
┌─────────────────────────────────────────────┐
│               Electron Application          │
│  ┌───────────────────────────────────────┐  │
│  │   Renderer  —  React UI (sandboxed)   │  │
│  └───────────────────┬───────────────────┘  │
│                      │ contextBridge + IPC  │
│  ┌───────────────────▼───────────────────┐  │
│  │   Main  —  app logic, files, SSH/SFTP │  │
│  └───────────────────┬───────────────────┘  │
└──────────────────────┼──────────────────────┘
                       ▼  SSH / SFTP
              ┌─────────────────┐
              │  Remote Server  │
              └─────────────────┘
```

The renderer never touches Node, the filesystem, or credentials. It runs with
`contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`, and can
only call the handful of functions explicitly bridged in
[`src/preload/preload.ts`](src/preload/preload.ts).

## Project structure

```text
src/
├── main/          Electron main process
│   ├── main.ts        window creation, app lifecycle
│   ├── security.ts    CSP, navigation guards
│   ├── logger.ts      structured logging with credential redaction
│   ├── ipc/           validated IPC handlers
│   ├── services/      local files, connections, saved profiles, SSH config import
│   ├── transfers/     uploads and downloads: progress, safe writes, conflicts
│   ├── sftp/          SftpProvider abstraction, ssh2 implementation, host-key trust store
│   ├── ssh/           private keys, ~/.ssh/config reading
│   ├── secrets/       OS keychain access (the only place secrets are stored)
│   └── storage/       connections.json and other app data files
├── preload/       the contextBridge API surface
├── renderer/      React application
└── shared/        types and channel constants used by both sides
test/support/      OpenSSH container helper for tests
```

## Using the panes

Local files are on the left, the remote server on the right. One pane is active at
a time (highlighted); menu commands act on it. Drag the divider to resize (or
focus it and use ←/→; double-click resets) — the position is remembered.

| Keys (macOS; Ctrl/Alt on Windows and Linux) | Action |
|---|---|
| `Tab` / `Shift+Tab` from a file list | Switch pane |
| `Cmd+1` / `Cmd+2` | Focus Local / Remote |
| `↑` `↓` · `Enter` · `Backspace` | Select · Open · Parent folder |
| `Cmd+R` or `F5` | Refresh the active pane |
| `Cmd+[` · `Cmd+↑` | Back · Parent folder (Go menu) |
| Click · `Cmd`-click · `Shift`-click · `Shift+↑/↓` · `Cmd+A` | Select · add or remove · select a range · select all |
| `Cmd+T` | Transfer the active pane's selection to the other pane's folder |
| `Cmd+Shift+N` · `F2` · `Delete` (`Cmd+Backspace` on macOS) | New folder · Rename · Delete the selection |

## Transferring files

Select files and folders and press **Upload** (local pane), **Download** (remote
pane) or `Cmd+T`. They go to the folder the other pane is showing, which refreshes
as they arrive. Folders are copied with everything inside them.

- **The Transfers panel** lists every file: Queued, Running (with progress and
  speed), Completed, Failed or Cancelled. Three run at a time. Cancel or Retry any
  of them, or use Cancel all / Retry failed / Clear finished.
- **If names already exist**, Fly asks once for the whole request: **Replace**
  (folders are merged — files with the same name are replaced, nothing is
  deleted), **Keep both** (saves `name (1).ext`), **Skip** or **Cancel**. A file
  never replaces a folder.
- **If the connection drops**, the unfinished files are marked Failed. Reconnect
  and choose **Retry failed**.
- Files are written under a hidden temporary name and renamed only once complete,
  so a failed or cancelled transfer never leaves a half-written file behind.
  Permissions and modification times are kept. Links to folders inside a folder
  being transferred are skipped (and reported).

## Managing files

Both panes can create folders (toolbar button or **File › New Folder**), rename
(**F2**) and delete the selection (**Delete**, or **Cmd+Backspace** on macOS).

- **Local deletes go to the Trash** (Recycle Bin on Windows), so they can be
  restored. If the Trash isn't available, nothing is deleted.
- **Remote deletes are permanent**, and Fly asks first. Folders are deleted with
  their contents; a link is removed as a link, never followed.
- Renaming never replaces an existing item, and Fly refuses to delete or rename
  your home folder or any folder that contains it.

## Security notes

- **Host keys** are trusted on first use: Fly shows the fingerprint before
  connecting, remembers the key, and refuses to connect if it ever changes.
- **Passwords and key passphrases** are stored only in the operating system's
  keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service),
  and only if you tick "Remember" and the server accepts them. Saved connections
  (`connections.json`) contain no secrets.
- **Private key files** are read by the main process when connecting; the UI
  never receives key contents.
- **Importing `~/.ssh/config`** asks first if your config contains `Match exec`,
  because reading host settings with `ssh -G` runs those commands.
