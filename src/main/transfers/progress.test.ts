import { describe, expect, it } from 'vitest'
import { createProgressReporter, type ProgressSnapshot } from './progress'

describe('createProgressReporter', () => {
  it('turns thousands of chunk callbacks into a few updates', () => {
    let clock = 0
    const emitted: ProgressSnapshot[] = []
    const reporter = createProgressReporter({ now: () => clock, emit: (s) => emitted.push(s), intervalMs: 100 })

    // One simulated second of 32 KB chunks every 0.4 ms (~2,600 callbacks).
    for (let i = 1; i <= 2600; i++) {
      clock = i * 0.4
      reporter.update(i * 32_768, 2600 * 32_768)
    }
    expect(emitted.length).toBeGreaterThanOrEqual(10)
    expect(emitted.length).toBeLessThanOrEqual(12)
    expect(reporter.snapshot().transferred).toBe(2600 * 32_768)
  })

  it('reports speed averaged over the recent window', () => {
    let clock = 0
    const reporter = createProgressReporter({ now: () => clock, emit: () => undefined, windowMs: 2000 })
    // 10 MB/s for 3 seconds, sampled every 100 ms.
    for (let t = 0; t <= 3000; t += 100) {
      clock = t
      reporter.update((t / 1000) * 10_000_000, 30_000_000)
    }
    expect(reporter.snapshot().bytesPerSecond).toBeCloseTo(10_000_000, -4)
  })

  it('never reports a negative or undefined speed', () => {
    const reporter = createProgressReporter({ now: () => 5, emit: () => undefined })
    reporter.update(0, 100)
    expect(reporter.snapshot().bytesPerSecond).toBe(0)
    reporter.update(50, 100)
    expect(reporter.snapshot().bytesPerSecond).toBe(0)
  })
})
