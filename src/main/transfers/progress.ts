/**
 * Turns ssh2's per-chunk progress callbacks (thousands per second) into a few
 * updates per second, with a speed averaged over a short window.
 */

export interface ProgressSnapshot {
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface ProgressReporterOptions {
  now: () => number
  emit: (snapshot: ProgressSnapshot) => void
  /** Minimum time between emitted updates. */
  intervalMs?: number
  /** How far back the speed average looks. */
  windowMs?: number
}

export interface ProgressReporter {
  /** Record progress; emits only if the interval has passed. */
  update: (transferred: number, total: number) => void
  /** The latest snapshot, emitted or not. */
  snapshot: () => ProgressSnapshot
}

export function createProgressReporter({ now, emit, intervalMs = 100, windowMs = 2000 }: ProgressReporterOptions): ProgressReporter {
  const samples: Array<{ at: number; transferred: number }> = []
  let lastEmit = Number.NEGATIVE_INFINITY
  let current: ProgressSnapshot = { transferred: 0, total: 0, bytesPerSecond: 0 }

  const speed = (at: number): number => {
    while (samples.length > 2 && (samples[1]?.at ?? at) <= at - windowMs) samples.shift()
    const first = samples[0]
    const last = samples[samples.length - 1]
    if (first === undefined || last === undefined || last.at <= first.at) return 0
    return Math.max(0, ((last.transferred - first.transferred) / (last.at - first.at)) * 1000)
  }

  return {
    update(transferred, total) {
      const at = now()
      samples.push({ at, transferred })
      current = { transferred, total, bytesPerSecond: speed(at) }
      if (at - lastEmit >= intervalMs) {
        lastEmit = at
        emit(current)
      }
    },
    snapshot: () => current
  }
}
