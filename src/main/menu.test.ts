import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { MENU_COMMANDS, type MenuCommand, isMenuCommand } from '../shared/types/menu'
import { buildApplicationMenu, menuItemId } from './menu'

type Item = MenuItemConstructorOptions

/** Every item in the template, with the label of the top-level menu it sits in. */
function flatten(items: Item[], parent = ''): Array<{ item: Item; parent: string }> {
  return items.flatMap((item) => {
    const own = { item, parent }
    const children = Array.isArray(item.submenu) ? flatten(item.submenu, item.label ?? item.role ?? '') : []
    return [own, ...children]
  })
}

const roles = (items: Item[]): string[] => flatten(items).map(({ item }) => String(item.role ?? '').toLowerCase())

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

describe('buildApplicationMenu', () => {
  describe.each(PLATFORMS)('on %s', (platform) => {
    it('keeps the Edit role, so copy and paste work in text fields', () => {
      expect(roles(buildApplicationMenu({ platform, isDev: false, send: () => undefined }))).toContain('editmenu')
    })

    it('never binds reload in View, and ships no reload or DevTools when packaged', () => {
      const packaged = buildApplicationMenu({ platform, isDev: false, send: () => undefined })
      expect(roles(packaged)).not.toContain('reload')
      expect(roles(packaged)).not.toContain('forcereload')
      expect(roles(packaged)).not.toContain('toggledevtools')
      expect(packaged.some((menu) => menu.label === 'Developer')).toBe(false)
    })

    it('offers reload and DevTools only under Developer in unpackaged builds', () => {
      const dev = buildApplicationMenu({ platform, isDev: true, send: () => undefined })
      const developerOnly = flatten(dev).filter(({ item }) => ['forcereload', 'toggledevtools'].includes(String(item.role ?? '').toLowerCase()))
      expect(developerOnly.map(({ parent }) => parent)).toEqual(['Developer', 'Developer'])
      expect(roles(dev)).not.toContain('reload')
    })

    it('has exactly one item per command, each sending its command', () => {
      const sent: MenuCommand[] = []
      const template = buildApplicationMenu({ platform, isDev: true, send: (command) => sent.push(command) })
      const commandItems = flatten(template).filter(({ item }) => item.id?.startsWith('command:'))

      expect(commandItems.map(({ item }) => item.id).sort()).toEqual(MENU_COMMANDS.map(menuItemId).sort())
      for (const { item } of commandItems) {
        ;(item.click as () => void)()
      }
      expect([...sent].sort()).toEqual([...MENU_COMMANDS].sort())
    })

    it('uses the standard app and window menus only on macOS', () => {
      const r = roles(buildApplicationMenu({ platform, isDev: false, send: () => undefined }))
      expect(r.includes('appmenu')).toBe(platform === 'darwin')
      expect(r.includes('windowmenu')).toBe(platform === 'darwin')
    })
  })

  it.each([
    ['darwin', { refresh: 'CmdOrCtrl+R', 'focus-local': 'CmdOrCtrl+1', 'focus-remote': 'CmdOrCtrl+2', 'go-back': 'Cmd+[', 'go-up': 'Cmd+Up', transfer: 'CmdOrCtrl+T' }],
    ['win32', { refresh: 'CmdOrCtrl+R', 'focus-local': 'CmdOrCtrl+1', 'focus-remote': 'CmdOrCtrl+2', 'go-back': 'Alt+Left', 'go-up': 'Alt+Up', transfer: 'CmdOrCtrl+T' }],
    ['linux', { refresh: 'CmdOrCtrl+R', 'focus-local': 'CmdOrCtrl+1', 'focus-remote': 'CmdOrCtrl+2', 'go-back': 'Alt+Left', 'go-up': 'Alt+Up', transfer: 'CmdOrCtrl+T' }]
  ] as const)('uses platform-appropriate shortcuts on %s', (platform, expected) => {
    const template = buildApplicationMenu({ platform, isDev: false, send: () => undefined })
    const accelerators = Object.fromEntries(
      flatten(template)
        .filter(({ item }) => item.id?.startsWith('command:'))
        .map(({ item }) => [item.id?.slice('command:'.length), item.accelerator])
    )
    expect(accelerators).toEqual(expected)
  })
})

describe('isMenuCommand', () => {
  it('accepts known commands only', () => {
    for (const command of MENU_COMMANDS) expect(isMenuCommand(command)).toBe(true)
    for (const value of ['reload', '', null, 42, { command: 'refresh' }]) expect(isMenuCommand(value)).toBe(false)
  })
})
