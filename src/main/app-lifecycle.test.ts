import { describe, expect, it } from 'vitest'
import { developmentUserData, stopTransfersQuestion } from './app-lifecycle'

describe('developmentUserData', () => {
  it('separates unpackaged runs from the installed app, unless a folder was given', () => {
    expect(developmentUserData({ isPackaged: false, hasUserDataSwitch: false, appData: '/Users/me/Library/Application Support' })).toBe(
      '/Users/me/Library/Application Support/Fly (development)'
    )
    expect(developmentUserData({ isPackaged: false, hasUserDataSwitch: true, appData: '/x' })).toBeNull()
    expect(developmentUserData({ isPackaged: true, hasUserDataSwitch: false, appData: '/x' })).toBeNull()
  })
})

describe('stopTransfersQuestion', () => {
  it('asks nothing when no transfer would be cancelled', () => {
    expect(stopTransfersQuestion(0, 'quit')).toBeNull()
    expect(stopTransfersQuestion(0, 'close')).toBeNull()
  })

  it('asks before quitting, with Cancel as the default', () => {
    expect(stopTransfersQuestion(3, 'quit')).toMatchObject({
      message: 'Quit Fly and cancel 3 transfers?',
      buttons: ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0
    })
    expect(stopTransfersQuestion(1, 'close')?.message).toBe('Close the window and cancel 1 transfer?')
    expect(stopTransfersQuestion(1, 'close')?.buttons).toEqual(['Cancel', 'Close'])
  })
})
