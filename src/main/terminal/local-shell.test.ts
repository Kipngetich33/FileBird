import { describe, expect, it } from 'vitest'
import { defaultShell, shellEnvironment, TERM_NAME } from './local-shell'
import { quoteForShell } from './shell'

describe('shellEnvironment', () => {
  it('keeps the user’s environment but never Fly’s own switches', () => {
    const env = shellEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--require=/x.js',
      FLY_DEV_HOME: '/tmp/fixture',
      FLY_DEV_TRASH_DIR: '/tmp/trash',
      EMPTY: undefined
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', TERM: TERM_NAME })
  })

  it('tells the shell what kind of terminal it is talking to', () => {
    expect(shellEnvironment({ TERM: 'dumb' })['TERM']).toBe(TERM_NAME)
  })
})

describe('defaultShell', () => {
  it('uses the shell the system names, as a login shell on macOS', () => {
    expect(defaultShell('darwin', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'] })
    expect(defaultShell('linux', { SHELL: '/usr/bin/fish' })).toEqual({ file: '/usr/bin/fish', args: [] })
  })

  it('falls back to the platform’s usual shell', () => {
    expect(defaultShell('linux', {})).toEqual({ file: '/bin/bash', args: [] })
    expect(defaultShell('win32', {})).toEqual({ file: 'powershell.exe', args: [] })
    expect(defaultShell('win32', { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: []
    })
  })
})

describe('quoteForShell', () => {
  it('makes a path one word, whatever is in it', () => {
    expect(quoteForShell('/home/me/my files')).toBe("'/home/me/my files'")
    expect(quoteForShell('/srv/$(whoami)`id`;rm -rf /')).toBe("'/srv/$(whoami)`id`;rm -rf /'")
  })

  it('closes and reopens the quotes around a quote', () => {
    expect(quoteForShell("/srv/it's here")).toBe("'/srv/it'\\''s here'")
    // What the shell reads back is the path itself.
    expect(quoteForShell("a'b")).toBe("'a'\\''b'")
  })
})
