import { describe, expect, it } from 'vitest'
import { MAX_TERMINALS_PER_PANE, maxTerminalsFor } from '@shared/constants/terminals'
import { leaf, splitPane } from './terminal-layout'
import { afterClosing, canAddTerminal, terminalKey, terminalLabel, totalPanes, type TerminalTab } from './terminal-tabs'

const tabs = (...keys: string[]): TerminalTab[] => keys.map((key) => ({ key, layout: leaf(`${key}-1`, null) }))

describe('how many a pane may run', () => {
  it('allows more until the cap, counting the tabs', () => {
    expect(canAddTerminal(tabs(), 'remote')).toBe(true)
    expect(canAddTerminal(tabs('a', 'b'), 'remote')).toBe(true)
    expect(canAddTerminal(tabs('a', 'b', 'c', 'd'), 'remote')).toBe(false)
  })

  it('counts split panes too, not just tabs', () => {
    const split = [{ key: 'a', layout: splitPane(leaf('a-1', null), 'a-1', leaf('a-2', null), 'row', 's1') }]
    expect(totalPanes(split)).toBe(2)
    expect(canAddTerminal([...split, ...tabs('b', 'c')], 'remote')).toBe(false)
  })

  it('leaves a remote pane a spare SSH channel, and allows a local pane more', () => {
    // A server allows about ten channels; browsing takes one and transfers up to four.
    expect(maxTerminalsFor('remote')).toBeLessThanOrEqual(5)
    expect(maxTerminalsFor('local')).toBeGreaterThan(MAX_TERMINALS_PER_PANE.remote)
  })
})

describe('labels and keys', () => {
  it('numbers tabs by position, so closing one never leaves a gap', () => {
    expect([0, 1, 2].map(terminalLabel)).toEqual(['Terminal', 'Terminal 2', 'Terminal 3'])
  })

  it('gives each tab a key of its own', () => {
    expect(new Set([1, 2, 3].map(terminalKey)).size).toBe(3)
  })
})

describe('afterClosing', () => {
  it('hands over to the tab on the left', () => {
    expect(afterClosing(tabs('a', 'b', 'c'), 'b', 'b')).toEqual({ tabs: tabs('a', 'c'), active: 'a' })
  })

  it('hands over to the right when the first tab is closed', () => {
    expect(afterClosing(tabs('a', 'b', 'c'), 'a', 'a')).toEqual({ tabs: tabs('b', 'c'), active: 'b' })
  })

  it('leaves the selection alone when another tab is closed', () => {
    expect(afterClosing(tabs('a', 'b', 'c'), 'c', 'a')).toEqual({ tabs: tabs('a', 'b'), active: 'a' })
  })

  it('reports no terminal left once the last one is closed', () => {
    expect(afterClosing(tabs('a'), 'a', 'a')).toEqual({ tabs: [], active: null })
  })

  it('ignores a tab that is already gone, and keeps the rest', () => {
    expect(afterClosing(tabs('a', 'b'), 'gone', 'b')).toEqual({ tabs: tabs('a', 'b'), active: 'b' })
  })

  it('never leaves a selection pointing at a closed tab', () => {
    let current = { tabs: tabs('a', 'b', 'c'), active: 'c' as string | null }
    for (const closing of ['c', 'a', 'b']) {
      current = afterClosing(current.tabs, closing, current.active)
      expect(current.active === null || current.tabs.some((tab) => tab.key === current.active)).toBe(true)
    }
    expect(current).toEqual({ tabs: [], active: null })
  })
})
