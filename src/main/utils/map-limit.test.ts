import { describe, expect, it } from 'vitest'
import { mapLimit } from './map-limit'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

describe('mapLimit', () => {
  it('returns results in input order, not completion order', async () => {
    const result = await mapLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return ms
    })
    expect(result).toEqual([30, 10, 20])
  })

  it('never runs more than `limit` calls at once', async () => {
    let active = 0
    let peak = 0
    await mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      active += 1
      peak = Math.max(peak, active)
      await tick()
      active -= 1
    })
    expect(peak).toBe(4)
  })

  it('handles an empty list and a non-positive limit', async () => {
    expect(await mapLimit([], 8, async (x: number) => x)).toEqual([])
    expect(await mapLimit([1, 2], 0, async (x) => x * 2)).toEqual([2, 4])
  })

  it('rejects if any call rejects', async () => {
    await expect(mapLimit([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('boom')
      return x
    })).rejects.toThrow('boom')
  })
})
