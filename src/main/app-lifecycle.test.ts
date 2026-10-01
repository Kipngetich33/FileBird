import { describe, expect, it } from 'vitest'
import { SPLASH_DURATION_MS, downloadDirectory, splashDuration, splashWait, stopTransfersQuestion, userDataFolder } from './app-lifecycle'

describe('userDataFolder', () => {
  it('separates unpackaged runs from the installed app, unless a folder was given', () => {
    expect(userDataFolder({ isPackaged: false, hasUserDataSwitch: false, appData: '/Users/me/Library/Application Support' })).toBe(
      '/Users/me/Library/Application Support/Fly (development)'
    )
    expect(userDataFolder({ isPackaged: false, hasUserDataSwitch: true, appData: '/x' })).toBeNull()
    expect(userDataFolder({ isPackaged: true, hasUserDataSwitch: true, appData: '/x' })).toBeNull()
  })

  it('keeps the installed app in the folder it has always used, whatever the app is called', () => {
    expect(userDataFolder({ isPackaged: true, hasUserDataSwitch: false, appData: '/Users/me/Library/Application Support' })).toBe(
      '/Users/me/Library/Application Support/fly'
    )
  })
})

describe('stopTransfersQuestion', () => {
  it('asks nothing when no transfer would be cancelled', () => {
    expect(stopTransfersQuestion(0, 'quit')).toBeNull()
    expect(stopTransfersQuestion(0, 'close')).toBeNull()
  })

  it('asks before quitting, with Cancel as the default', () => {
    expect(stopTransfersQuestion(3, 'quit')).toMatchObject({
      message: 'Quit FileBird and cancel 3 transfers?',
      buttons: ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0
    })
    expect(stopTransfersQuestion(1, 'close')?.message).toBe('Close the window and cancel 1 transfer?')
    expect(stopTransfersQuestion(1, 'close')?.buttons).toEqual(['Cancel', 'Close'])
  })
})

describe('splash timing', () => {
  it('shows the start screen for 6 seconds in the installed app, whatever the environment says', () => {
    expect(splashDuration({ isPackaged: true, override: '0' })).toBe(SPLASH_DURATION_MS)
    expect(SPLASH_DURATION_MS).toBe(6000)
  })

  it('lets unpackaged runs shorten or skip it', () => {
    expect(splashDuration({ isPackaged: false, override: undefined })).toBe(6000)
    expect(splashDuration({ isPackaged: false, override: '0' })).toBe(0)
    expect(splashDuration({ isPackaged: false, override: '1500' })).toBe(1500)
    expect(splashDuration({ isPackaged: false, override: 'soon' })).toBe(6000)
    expect(splashDuration({ isPackaged: false, override: '999999' })).toBe(30_000)
  })

  it('waits out whatever is left of the start screen', () => {
    expect(splashWait({ shownAt: 1_000, now: 2_500, durationMs: 4_000 })).toBe(2_500)
    expect(splashWait({ shownAt: 1_000, now: 9_000, durationMs: 4_000 })).toBe(0)
    expect(splashWait({ shownAt: null, now: 9_000, durationMs: 4_000 })).toBe(4_000)
  })
})

describe('downloadDirectory', () => {
  const always = (): boolean => true

  it('sends a download to the Downloads folder, where everything else puts what it fetches', () => {
    expect(downloadDirectory({ home: '/Users/me', downloads: '/Users/me/Downloads', isDirectory: always })).toBe('/Users/me/Downloads')
  })

  it('falls back to the home folder when there is no Downloads folder', () => {
    expect(downloadDirectory({ home: '/Users/me', downloads: null, isDirectory: always })).toBe('/Users/me')
    expect(downloadDirectory({ home: '/Users/me', downloads: '/Users/me/Downloads', isDirectory: () => false })).toBe('/Users/me')
    expect(downloadDirectory({ home: '/Users/me', downloads: '/Users/me', isDirectory: always })).toBe('/Users/me')
  })
})
