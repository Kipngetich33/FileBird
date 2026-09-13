import { app, BrowserWindow, dialog, Menu, type OpenDialogOptions } from 'electron'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { IPC_EVENTS } from '../shared/constants/channels'
import { registerConnectionsIpc } from './ipc/connections.ipc'
import { buildApplicationMenu } from './menu'
import { registerLocalFilesIpc } from './ipc/local-files.ipc'
import { registerSftpIpc } from './ipc/sftp.ipc'
import { registerSystemIpc } from './ipc/system.ipc'
import { KeyringSecretStore } from './secrets/keyring-secret-store'
import { keychainService } from './secrets/secret-store'
import { ConnectionProfilesService } from './services/connection-profiles.service'
import { ConnectionService } from './services/connection.service'
import { SshConfigImportService } from './services/ssh-config-import.service'
import { HostKeyStore } from './sftp/host-keys'
import { Ssh2SftpProvider } from './sftp/ssh2-provider'
import { SshConfigImporter } from './ssh/ssh-config'
import { ConnectionStorage } from './storage/connection-storage'
import { applyContentSecurityPolicy, guardNavigation } from './security'
import { logger } from './logger'

const isDev = !app.isPackaged
const rendererUrl = process.env['ELECTRON_RENDERER_URL']

let connections: ConnectionService | null = null

/**
 * The home folder Fly starts in and reads ~/.ssh/config from. Unpackaged builds
 * accept FLY_DEV_HOME so the smoke test can use a fixture folder: overriding HOME
 * instead would also hide the macOS login keychain. Packaged builds ignore it.
 */
const appHome = !app.isPackaged && process.env['FLY_DEV_HOME'] ? process.env['FLY_DEV_HOME'] : homedir()

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Fly',
    backgroundColor: '#0b0d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // Spec section 20 — these five lines are the security boundary.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  // Avoid the white flash: hold the window back until React has painted.
  window.once('ready-to-show', () => window.show())

  if (isDev && rendererUrl !== undefined) {
    guardNavigation(window, new URL(rendererUrl).origin)
    void window.loadURL(rendererUrl)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    guardNavigation(window, null)
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** The native file dialog, opened by the main process so the renderer only ever receives a path. */
async function pickPrivateKey(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a private key',
    buttonLabel: 'Choose',
    defaultPath: join(appHome, '.ssh'),
    properties: ['openFile', 'showHiddenFiles']
  }
  const window = BrowserWindow.getFocusedWindow()
  const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

void app.whenReady().then(() => {
  app.setAppUserModelId('com.titansoft.fly')

  applyContentSecurityPolicy()
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenu({
        platform: process.platform,
        isDev,
        send: (command) => {
          const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          window?.webContents.send(IPC_EVENTS.MENU_COMMAND, { command })
        }
      })
    )
  )
  registerSystemIpc()
  registerLocalFilesIpc(appHome)

  const userData = app.getPath('userData')

  connections = new ConnectionService({
    hostKeys: new HostKeyStore(join(userData, 'known-hosts.json')),
    createProvider: () => new Ssh2SftpProvider(),
    onConnectionClosed: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_EVENTS.SFTP_CONNECTION_CLOSED, event)
      }
    }
  })
  registerSftpIpc(connections)

  const profiles = new ConnectionProfilesService({
    storage: new ConnectionStorage(join(userData, 'connections.json')),
    secrets: new KeyringSecretStore(keychainService(app.isPackaged)),
    connections
  })
  const imports = new SshConfigImportService(
    new SshConfigImporter({ home: appHome, localUser: userInfo().username, localHost: hostname() }),
    profiles
  )
  registerConnectionsIpc({ profiles, imports, pickPrivateKey })

  createMainWindow()

  logger.info('Application ready', {
    mode: isDev ? 'development' : 'production',
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch
  })

  // macOS: clicking the dock icon with no windows open reopens one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // No window means no one can see or use a connection, so don't keep it open.
  void connections?.disconnectAll()
  // macOS apps conventionally stay running with no windows; other platforms quit.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void connections?.disconnectAll()
})
