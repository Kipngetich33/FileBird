import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, applySelect, pruneSelection, selectAll } from './selection'

const ORDER = ['/a', '/b', '/c', '/d', '/e']

describe('selection', () => {
  it('a plain click selects one row and moves the cursor and anchor', () => {
    const selection = applySelect(applySelect(EMPTY_SELECTION, ORDER, '/b'), ORDER, '/d')
    expect(selection).toEqual({ paths: ['/d'], cursor: '/d', anchor: '/d' })
  })

  it('Cmd/Ctrl-click toggles rows and keeps display order', () => {
    let selection = applySelect(EMPTY_SELECTION, ORDER, '/d')
    selection = applySelect(selection, ORDER, '/a', 'toggle')
    expect(selection.paths).toEqual(['/a', '/d'])
    selection = applySelect(selection, ORDER, '/d', 'toggle')
    expect(selection).toEqual({ paths: ['/a'], cursor: '/d', anchor: '/d' })
  })

  it('Shift selects the range from the anchor, in either direction, keeping the anchor', () => {
    let selection = applySelect(EMPTY_SELECTION, ORDER, '/c')
    selection = applySelect(selection, ORDER, '/e', 'range')
    expect(selection).toEqual({ paths: ['/c', '/d', '/e'], cursor: '/e', anchor: '/c' })
    selection = applySelect(selection, ORDER, '/a', 'range')
    expect(selection).toEqual({ paths: ['/a', '/b', '/c'], cursor: '/a', anchor: '/c' })
  })

  it('a range with no anchor starts at the clicked row', () => {
    expect(applySelect(EMPTY_SELECTION, ORDER, '/b', 'range')).toEqual({ paths: ['/b'], cursor: '/b', anchor: '/b' })
  })

  it('select all keeps the cursor where it was', () => {
    expect(selectAll(applySelect(EMPTY_SELECTION, ORDER, '/c'), ORDER)).toEqual({ paths: ORDER, cursor: '/c', anchor: '/a' })
    expect(selectAll(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION)
  })

  it('pruning drops rows that disappeared, and returns the same object when none did', () => {
    const selection = { paths: ['/b', '/c'], cursor: '/c', anchor: '/b' }
    expect(pruneSelection(selection, ORDER)).toBe(selection)
    expect(pruneSelection(selection, ['/a', '/b'])).toEqual({ paths: ['/b'], cursor: null, anchor: '/b' })
  })
})
