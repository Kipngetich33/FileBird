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

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development mode with hot reload |
| `npm run build` | Typecheck, then build main / preload / renderer |
| `npm run start` | Preview the production build |
| `npm run typecheck` | Typecheck both TS projects |
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
│   └── ipc/           validated IPC handlers
├── preload/       the contextBridge API surface
├── renderer/      React application
└── shared/        types and channel constants used by both sides
```
