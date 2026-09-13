import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPLIT,
  LAYOUT_STORAGE_KEY,
  MIN_PANE_PX,
  clampSplit,
  readStoredSplit,
  splitBounds,
  storeSplit
} from './split'

describe('splitBounds', () => {
  it('keeps both panes at least the minimum width', () => {
    const { min, max } = splitBounds(1000)
    expect((min / 100) * 1000).toBeCloseTo(MIN_PANE_PX)
    expect(((100 - max) / 100) * 1000).toBeCloseTo(MIN_PANE_PX)
  })

  it('allows only an even split when the minimums cannot both fit', () => {
    expect(splitBounds(640)).toEqual({ min: 50, max: 50 })
    expect(splitBounds(300)).toEqual({ min: 50, max: 50 })
    expect(splitBounds(Number.NaN)).toEqual({ min: 50, max: 50 })
  })
})

describe('clampSplit', () => {
  it.each([
    [50, 1000, 50],
    [10, 1000, 32],
    [95, 1000, 68],
    [33.333, 1000, 33.3],
    [80, 640, 50],
    [Number.NaN, 1000, DEFAULT_SPLIT],
    [Number.POSITIVE_INFINITY, 1000, DEFAULT_SPLIT]
  ])('clamps %s%% in %spx to %s', (percent, width, expected) => {
    expect(clampSplit(percent, width)).toBe(expected)
  })

  it('re-clamps a remembered position when the window gets narrower', () => {
    const wide = clampSplit(75, 1600)
    expect(wide).toBe(75)
    expect(clampSplit(wide, 900)).toBeCloseTo(64.4, 1)
  })
})

describe('remembered position', () => {
  const memory = (): Storage => {
    const items = new Map<string, string>()
    return {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
      removeItem: (key) => void items.delete(key),
      clear: () => items.clear(),
      key: () => null,
      get length() {
        return items.size
      }
    }
  }

  it('round-trips', () => {
    const storage = memory()
    storeSplit(storage, 62.5)
    expect(readStoredSplit(storage)).toBe(62.5)
  })

  it.each([['not json'], ['{"split":"60"}'], ['{"split":0}'], ['{"split":100}'], ['null'], ['[]']])(
    'falls back to the default for %s',
    (raw) => {
      const storage = memory()
      storage.setItem(LAYOUT_STORAGE_KEY, raw)
      expect(readStoredSplit(storage)).toBe(DEFAULT_SPLIT)
    }
  )

  it('never throws when storage is missing or refuses', () => {
    expect(readStoredSplit(null)).toBe(DEFAULT_SPLIT)
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(readStoredSplit(refusing)).toBe(DEFAULT_SPLIT)
    expect(() => storeSplit(refusing, 40)).not.toThrow()
  })
})
