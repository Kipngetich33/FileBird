import { describe, expect, it } from 'vitest'
import {
  BACK_BRANCH,
  BRANCHES,
  END,
  OUT_BRANCH,
  START,
  arrivalPulse,
  birdAt,
  branchOffset,
  branchPoint,
  centre,
  makeThreads,
  spread,
  statusFor,
  weaveWidth
} from './stream'

describe('the stream of light', () => {
  it('runs from the bottom-left base to the top-right base', () => {
    expect(centre(0)).toEqual(START)
    expect(centre(1)).toEqual(END)
    expect(START.x).toBeLessThan(END.x)
    expect(START.y).toBeGreaterThan(END.y)
  })

  it('is one woven band at both ends and parted into branches in the middle', () => {
    for (const branch of BRANCHES.keys()) {
      expect(branchOffset(branch, 0.02, 0)).toBeCloseTo(0, 5)
      expect(branchOffset(branch, 0.98, 0)).toBeCloseTo(0, 5)
    }
    const middle = BRANCHES.map((_, branch) => branchOffset(branch, 0.5, 0))
    expect(Math.max(...middle) - Math.min(...middle)).toBeGreaterThan(80)
  })

  it('splits and rejoins like tributaries, each branch at its own point', () => {
    const splits = new Set(BRANCHES.map((branch) => branch.split))
    const joins = new Set(BRANCHES.map((branch) => branch.join))
    expect(splits.size).toBe(BRANCHES.length)
    expect(joins.size).toBe(BRANCHES.length)
    for (const [index, branch] of BRANCHES.entries()) {
      expect(spread(branch.split - 0.01, index)).toBe(0)
      expect(spread(branch.join + 0.01, index)).toBe(0)
    }
  })

  it('is a thick band where it meets the bases and thinner once parted', () => {
    expect(weaveWidth(0.03, OUT_BRANCH)).toBeGreaterThan(10)
    expect(weaveWidth(0.97, OUT_BRANCH)).toBeGreaterThan(7)
    expect(weaveWidth(0.5, OUT_BRANCH)).toBeLessThan(8)
  })

  it('builds the same threads every launch, dealt to branches by weight', () => {
    const threads = makeThreads(50)
    expect(makeThreads(50)).toEqual(threads)
    const counts = BRANCHES.map((_, branch) => threads.filter((thread) => thread.branch === branch).length)
    expect(counts[1]).toBeGreaterThan(counts[2] ?? 0)
    expect(counts.every((count) => count > 0)).toBe(true)
  })
})

describe('the bird', () => {
  it('flies out to the server along one branch and back along another, every 6 seconds', () => {
    expect(birdAt(0)).toMatchObject({ t: 0, direction: 1 })
    const out = birdAt(1500)
    expect(out.direction).toBe(1)
    expect(out.branch).toBe(OUT_BRANCH)
    expect(out.t).toBeGreaterThan(0.2)
    expect(birdAt(3000)).toMatchObject({ t: 1 })
    const back = birdAt(4500)
    expect(back.direction).toBe(-1)
    expect(back.branch).toBe(BACK_BRANCH)
    expect(back.t).toBeGreaterThan(0.2)
    expect(back.t).toBeLessThan(0.8)
    expect(birdAt(6000)).toEqual(birdAt(0))
    expect(OUT_BRANCH).not.toBe(BACK_BRANCH)
  })

  it('moves only forward on the way out and only backward on the way back', () => {
    const outbound = [450, 1050, 1650, 2250, 2685].map((ms) => birdAt(ms).t)
    expect(outbound).toEqual([...outbound].sort((a, b) => a - b))
    const inbound = [3450, 4050, 4650, 5250, 5685].map((ms) => birdAt(ms).t)
    expect(inbound).toEqual([...inbound].sort((a, b) => b - a))
  })

  it('makes each base glow as it arrives, fading after', () => {
    expect(arrivalPulse(2700, 'end')).toBeCloseTo(1, 1)
    expect(arrivalPulse(3600, 'end')).toBeLessThan(0.3)
    expect(arrivalPulse(5700, 'start')).toBeCloseTo(1, 1)
  })

  it('makes one round trip over whatever time the start screen has, landing home before it ends', () => {
    expect(birdAt(2_000, 4_000)).toMatchObject({ t: 1 })
    expect(birdAt(5_700, 6_000)).toMatchObject({ t: 0 })
    expect(birdAt(9_500, 10_000)).toMatchObject({ t: 0 })
    expect(arrivalPulse(9_500, 'start', 10_000)).toBeCloseTo(1, 1)
  })

  it('stays on the stream', () => {
    const at = branchPoint(OUT_BRANCH, 0, 0)
    expect(at.x).toBeCloseTo(START.x)
    expect(at.y).toBeCloseTo(START.y)
  })
})

describe('statusFor', () => {
  it('says starting, then loading, never connecting', () => {
    expect(statusFor(0)).toBe('Starting…')
    expect(statusFor(0.6)).toBe('Loading…')
    expect(statusFor(0.95)).toBe('Almost ready…')
    for (const progress of [0, 0.3, 0.6, 0.9, 1]) expect(statusFor(progress)).not.toMatch(/connect/i)
  })
})
