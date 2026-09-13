// Renders resources/icon.svg to resources/icon.png (1024x1024) with Electron's own
// renderer, so no image tooling is needed. electron-builder derives .icns and .ico.
//
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '../resources/icon.svg'), 'utf8')
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  window.webContents.setFrameRate(1)
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024 }).toPNG()
  writeFileSync(join(__dirname, '../resources/icon.png'), png)
  console.log(`icon.png: ${image.getSize().width}x${image.getSize().height}, ${png.length} bytes`)
  app.quit()
})
