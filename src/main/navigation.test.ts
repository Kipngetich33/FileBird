import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from './navigation'

describe('isAllowedNavigation', () => {
  it('allows only the dev server origin in development', () => {
    const dev = { origin: 'http://localhost:5173' }
    expect(isAllowedNavigation('http://localhost:5173/', dev)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/some/route?x=1', dev)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5174/', dev)).toBe(false)
    expect(isAllowedNavigation('file:///Users/me/evil.html', dev)).toBe(false)
  })

  it('allows only the packaged index.html, ignoring a hash', () => {
    const packaged = { exactUrl: 'file:///Applications/FileBird.app/Contents/Resources/app.asar/out/renderer/index.html' }
    expect(isAllowedNavigation('file:///Applications/FileBird.app/Contents/Resources/app.asar/out/renderer/index.html', packaged)).toBe(true)
    expect(isAllowedNavigation('file:///Applications/FileBird.app/Contents/Resources/app.asar/out/renderer/index.html#top', packaged)).toBe(true)
    expect(isAllowedNavigation('file:///Users/me/Downloads/dropped.html', packaged)).toBe(false)
    expect(isAllowedNavigation('https://example.org/', packaged)).toBe(false)
    expect(isAllowedNavigation('not a url', packaged)).toBe(false)
  })
})
