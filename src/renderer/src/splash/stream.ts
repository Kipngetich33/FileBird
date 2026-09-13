/**
 * Geometry of the start screen's stream of light (pure, so it can be tested):
 * a woven band leaves the bottom-left end, splits into branches like a river's
 * tributaries in the middle, and merges again before the top-right end.
 *
 * Positions are in card pixels; `t` runs from 0 (start) to 1 (end).
 */

export interface Point {
  x: number
  y: number
}

export const CARD = { width: 780, height: 480 }
export const START: Point = { x: 100, y: 352 }
export const END: Point = { x: 682, y: 94 }
const PULL_START: Point = { x: 272, y: 300 }
const PULL_END: Point = { x: 466, y: 190 }

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value))

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const u = clamp((value - edge0) / (edge1 - edge0))
  return u * u * (3 - 2 * u)
}

export const easeInOut = (u: number): number => {
  const x = clamp(u)
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

/** The centre line: a cubic Bézier from START to END. */
export function centre(t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * START.x + 3 * u * u * t * PULL_START.x + 3 * u * t * t * PULL_END.x + t * t * t * END.x,
    y: u * u * u * START.y + 3 * u * u * t * PULL_START.y + 3 * u * t * t * PULL_END.y + t * t * t * END.y
  }
}

/** Unit direction of travel along the centre line. */
export function tangent(t: number): Point {
  const u = 1 - t
  const x = 3 * u * u * (PULL_START.x - START.x) + 6 * u * t * (PULL_END.x - PULL_START.x) + 3 * t * t * (END.x - PULL_END.x)
  const y = 3 * u * u * (PULL_START.y - START.y) + 6 * u * t * (PULL_END.y - PULL_START.y) + 3 * t * t * (END.y - PULL_END.y)
  const length = Math.hypot(x, y) || 1
  return { x: x / length, y: y / length }
}

/** Unit sideways direction; positive offsets move below and to the right of the line. */
export function normal(t: number): Point {
  const { x, y } = tangent(t)
  return { x: -y, y: x }
}

/**
 * The branches, like a river's tributaries: each leaves the band and rejoins it
 * at its own point, reaches its own distance to one side, and carries its own
 * share of the threads. `side` runs from -1 (upper edge) to 1 (lower edge).
 */
export interface Branch {
  side: number
  split: number
  join: number
  /** Share of the threads. */
  weight: number
  /** How widely its own threads weave. */
  width: number
}

export const BRANCHES: readonly Branch[] = [
  { side: -1.05, split: 0.29, join: 0.73, weight: 0.18, width: 4.5 },
  { side: -0.5, split: 0.22, join: 0.8, weight: 0.3, width: 7 },
  { side: -0.8, split: 0.44, join: 0.61, weight: 0.08, width: 3 },
  { side: 0.38, split: 0.27, join: 0.76, weight: 0.26, width: 6 },
  { side: 0.92, split: 0.37, join: 0.66, weight: 0.18, width: 4 }
]

export const MAX_SPREAD = 76

/** 0 where a branch is woven into the band, 1 where it has fully parted from it. */
export function spread(t: number, branch?: number): number {
  const shape = branch === undefined ? undefined : BRANCHES[branch]
  if (shape === undefined) return smoothstep(0.22, 0.45, t) * (1 - smoothstep(0.6, 0.82, t))
  return smoothstep(shape.split, shape.split + 0.18, t) * (1 - smoothstep(shape.join - 0.18, shape.join, t))
}

export function branchOffset(branch: number, t: number, time: number): number {
  const shape = BRANCHES[branch]
  if (shape === undefined) return 0
  const amount = spread(t, branch)
  const meander = 1 + 0.3 * Math.sin(t * 9 + branch * 2.3)
  const wander = 9 * Math.sin(t * 11 + branch * 1.9 + time * 0.6) * amount
  return shape.side * MAX_SPREAD * amount * meander + wander
}

/** Half the width a branch's threads weave across: a thick band at the bases, thinner once parted. */
export function weaveWidth(t: number, branch?: number): number {
  const band = 17 - 5 * t
  const parted = BRANCHES[branch ?? -1]?.width ?? 5
  // Slightly gathered where the band meets a base, but still a thick band.
  const gather = 0.68 + 0.32 * smoothstep(0, 0.1, t) * (1 - smoothstep(0.9, 1, t))
  return (band + (parted - band) * spread(t, branch)) * gather
}

/** Threads fade in from the start and out into the end, so the band flows from its bases. */
export function endFade(t: number): number {
  return 0.45 + 0.55 * smoothstep(0, 0.07, t) * (1 - smoothstep(0.94, 1, t))
}

export interface Thread {
  branch: number
  phase: number
  /** How many times it crosses the band along its length. */
  cycles: number
  amplitude: number
  colour: string
  width: number
  alpha: number
}

const COLOURS = ['#3b82f6', '#60a5fa', '#38bdf8', '#22d3ee', '#6366f1', '#818cf8', '#8b5cf6', '#a78bfa']

/** Deterministic, so the stream looks the same every launch. */
export function makeThreads(count: number, seed = 7): Thread[] {
  let state = seed
  const random = (): number => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
  // Threads are dealt to branches by weight, so the main channels are fuller.
  const shares = BRANCHES.map((branch) => branch.weight)
  const total = shares.reduce((sum, share) => sum + share, 0)
  const branchFor = (index: number): number => {
    let position = ((index + 0.5) / count) * total
    for (const [branch, share] of shares.entries()) {
      if (position < share) return branch
      position -= share
    }
    return shares.length - 1
  }
  return Array.from({ length: count }, (_, index) => ({
    branch: branchFor(index),
    phase: random() * Math.PI * 2,
    cycles: 2.2 + random() * 2.8,
    amplitude: 0.45 + random() * 0.55,
    colour: COLOURS[Math.floor(random() * COLOURS.length)] ?? '#60a5fa',
    width: 0.45 + random() * 0.8,
    alpha: 0.26 + random() * 0.36
  }))
}

export function threadPoint(thread: Thread, t: number, time: number): Point {
  const base = centre(t)
  const side = normal(t)
  const weave = Math.sin(Math.PI * 2 * thread.cycles * t + thread.phase - time * 1.5) * weaveWidth(t, thread.branch) * thread.amplitude
  const offset = branchOffset(thread.branch, t, time) + weave
  return { x: base.x + side.x * offset, y: base.y + side.y * offset }
}

/** A point on a branch's own centre (no weave), e.g. for the bird's route. */
export function branchPoint(branch: number, t: number, time: number): Point {
  const base = centre(t)
  const side = normal(t)
  const offset = branchOffset(branch, t, time)
  return { x: base.x + side.x * offset, y: base.y + side.y * offset }
}

/**
 * One round trip of the bird, repeating every `cycle` ms: out along an upper
 * branch to the server end, a moment there, back along a lower branch. The
 * start screen passes its own duration, so the bird is home as it ends.
 */
export interface BirdState {
  t: number
  branch: number
  /** 1 while flying out, -1 while flying back. */
  direction: 1 | -1
}

export const BIRD_CYCLE_MS = 6000
/** Out through the upper main channel, back through the lower one. */
export const OUT_BRANCH = 1
export const BACK_BRANCH = 3

export function birdAt(elapsed: number, cycle = BIRD_CYCLE_MS): BirdState {
  const phase = ((elapsed % cycle) + cycle) % cycle / cycle
  if (phase < 0.05) return { t: 0, branch: OUT_BRANCH, direction: 1 }
  if (phase < 0.45) return { t: easeInOut((phase - 0.05) / 0.4), branch: OUT_BRANCH, direction: 1 }
  if (phase < 0.55) return { t: 1, branch: BACK_BRANCH, direction: -1 }
  if (phase < 0.95) return { t: 1 - easeInOut((phase - 0.55) / 0.4), branch: BACK_BRANCH, direction: -1 }
  return { t: 0, branch: OUT_BRANCH, direction: 1 }
}

/** How strongly an end glows because the bird just reached it (0 to 1). */
export function arrivalPulse(elapsed: number, end: 'start' | 'end', cycle = BIRD_CYCLE_MS): number {
  const arrivedAt = end === 'end' ? 0.45 : 0.95
  const since = (((elapsed % cycle) + cycle) % cycle / cycle - arrivedAt + 1) % 1
  return Math.exp((-since * cycle) / 350)
}

/** What the start screen says as the time runs out. */
export function statusFor(progress: number): string {
  if (progress < 0.45) return 'Starting…'
  if (progress < 0.85) return 'Loading…'
  return 'Almost ready…'
}
