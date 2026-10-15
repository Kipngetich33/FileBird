import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZOOM,
  TERMINAL_BASE_FONT_PX,
  ZOOM_LEVELS,
  ZOOM_STORAGE_KEY,
  readStoredZoom,
  snapZoom,
  stepZoom,
  storeZoom,
  terminalFontSize,
  zoomPercent
} from './zoom'

/** A stand-in for localStorage, including one that refuses to be written to. */
function fakeStorage(initial: Record<string, string> = {}, { readOnly = false } = {}): Pick<Storage, 'getItem' | 'setItem'> & { items: Record<string, string> } {
  const items = { ...initial }
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      if (readOnly) throw new DOMException('quota', 'QuotaExceededError')
      items[key] = value
    }
  }
}

describe('the zoom ladder', () => {
  it('rises, includes 100%, and holds no duplicates', () => {
    expect([...ZOOM_LEVELS]).toEqual([...ZOOM_LEVELS].sort((a, b) => a - b))
    expect(new Set(ZOOM_LEVELS).size).toBe(ZOOM_LEVELS.length)
    expect(ZOOM_LEVELS).toContain(DEFAULT_ZOOM)
  })
})

describe('snapZoom', () => {
  it.each([
    [1, 1],
    [1.15, 1.15],
    [1.2, 1.15],
    [1.21, 1.15],
    [1.24, 1.3],
    [1.3, 1.3],
    [0.1, 0.75],
    [99, 2],
    [Number.NaN, DEFAULT_ZOOM],
    [Number.POSITIVE_INFINITY, DEFAULT_ZOOM]
  ])('snaps %s to %s', (level, expected) => {
    expect(snapZoom(level)).toBe(expected)
  })
})

describe('stepZoom', () => {
  it('walks the whole ladder in and out again', () => {
    let level = ZOOM_LEVELS[0] as number
    const up = [level]
    for (let i = 0; i < ZOOM_LEVELS.length + 2; i += 1) {
      level = stepZoom(level, 1)
      if (up[up.length - 1] !== level) up.push(level)
    }
    expect(up).toEqual([...ZOOM_LEVELS])

    const down: number[] = [level]
    for (let i = 0; i < ZOOM_LEVELS.length + 2; i += 1) {
      level = stepZoom(level, -1)
      if (down[down.length - 1] !== level) down.push(level)
    }
    expect(down).toEqual([...ZOOM_LEVELS].reverse())
  })

  it('stops at each end rather than wrapping round', () => {
    const smallest = ZOOM_LEVELS[0]
    const largest = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
    expect(stepZoom(smallest, -1)).toBe(smallest)
    expect(stepZoom(largest, 1)).toBe(largest)
  })

  it('never drifts off the ladder, however often it is stepped', () => {
    let level: number = DEFAULT_ZOOM
    for (const direction of [1, 1, -1, 1, -1, -1, 1] as const) {
      level = stepZoom(level, direction)
      expect(ZOOM_LEVELS).toContain(level)
    }
  })

  it('starts from the nearest level when given something off the ladder', () => {
    expect(stepZoom(1.2, 1)).toBe(1.3)
    expect(stepZoom(1.2, -1)).toBe(1)
    expect(stepZoom(Number.NaN, 1)).toBe(1.15)
  })
})

describe('what the user sees', () => {
  it('reports whole percentages', () => {
    expect(zoomPercent(1)).toBe(100)
    expect(zoomPercent(1.15)).toBe(115)
    expect(zoomPercent(0.75)).toBe(75)
    expect(zoomPercent(2)).toBe(200)
  })

  it('scales a terminal font to a whole number of pixels, keeping 100% exactly', () => {
    expect(terminalFontSize(1)).toBe(TERMINAL_BASE_FONT_PX)
    for (const level of ZOOM_LEVELS) {
      const size = terminalFontSize(level)
      expect(Number.isInteger(size)).toBe(true)
      expect(size).toBeGreaterThanOrEqual(8)
    }
    // Bigger levels never produce a smaller font.
    const sizes = ZOOM_LEVELS.map(terminalFontSize)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
  })
})

describe('remembering a level', () => {
  it('returns 100% when nothing has been stored', () => {
    expect(readStoredZoom(fakeStorage(), 'local')).toBe(DEFAULT_ZOOM)
    expect(readStoredZoom(null, 'remote')).toBe(DEFAULT_ZOOM)
  })

  it('keeps each pane its own level', () => {
    const storage = fakeStorage()
    storeZoom(storage, 'local', 1.3)
    storeZoom(storage, 'remote', 0.85)
    expect(readStoredZoom(storage, 'local')).toBe(1.3)
    expect(readStoredZoom(storage, 'remote')).toBe(0.85)
  })

  it('does not lose the other pane when one is written', () => {
    const storage = fakeStorage()
    storeZoom(storage, 'remote', 1.5)
    storeZoom(storage, 'local', 1.15)
    expect(readStoredZoom(storage, 'remote')).toBe(1.5)
  })

  it.each([
    ['not JSON at all', '{nope'],
    ['the wrong shape', '[1.5]'],
    ['a level that is not a number', '{"local":"1.5"}'],
    ['null', 'null']
  ])('falls back to 100%% for %s', (_why, raw) => {
    expect(readStoredZoom(fakeStorage({ [ZOOM_STORAGE_KEY]: raw }), 'local')).toBe(DEFAULT_ZOOM)
  })

  it('snaps a stored level onto the ladder, so an old or edited file cannot wedge a pane', () => {
    expect(readStoredZoom(fakeStorage({ [ZOOM_STORAGE_KEY]: '{"local":7}' }), 'local')).toBe(2)
    expect(readStoredZoom(fakeStorage({ [ZOOM_STORAGE_KEY]: '{"local":0.01}' }), 'local')).toBe(0.75)
    expect(readStoredZoom(fakeStorage({ [ZOOM_STORAGE_KEY]: '{"local":1.21}' }), 'local')).toBe(1.15)
  })

  it('shrugs off a storage that refuses to be written to', () => {
    const storage = fakeStorage({}, { readOnly: true })
    expect(() => storeZoom(storage, 'local', 1.5)).not.toThrow()
    expect(() => storeZoom(null, 'local', 1.5)).not.toThrow()
  })
})
