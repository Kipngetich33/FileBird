import { BIRD_BODY, BIRD_EYE, BIRD_FAR_WING, BIRD_NEAR_WING, BIRD_NEAR_WING_INNER, BIRD_SHOULDER, BIRD_SIZE } from './bird'
import {
  CARD,
  END,
  START,
  arrivalPulse,
  birdAt,
  branchPoint,
  centre,
  easeInOut,
  endFade,
  makeThreads,
  statusFor,
  tangent,
  threadPoint,
  type Point
} from './stream'
import './splash.css'

/**
 * The start screen (FileBird): a stream of light between a glowing base at the
 * bottom left (this computer) and one at the top right (the server), with a
 * bird carrying a packet out and back. Shown by the main process for a few
 * seconds while the app loads; the duration arrives in the URL.
 */

const DURATION_MS = Number(new URLSearchParams(location.search).get('duration')) || 6000
const SAMPLES = 110
const THREADS = makeThreads(46)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

const canvas = document.querySelector<HTMLCanvasElement>('#stream')
const statusText = document.querySelector<HTMLElement>('#status')
const bar = document.querySelector<HTMLElement>('#bar')
const fill = document.querySelector<HTMLElement>('#fill')
const context = canvas?.getContext('2d')

const bodyPath = new Path2D(BIRD_BODY)
const farWingPath = new Path2D(BIRD_FAR_WING)
const nearWingPath = new Path2D(BIRD_NEAR_WING)
const innerWingPath = new Path2D(BIRD_NEAR_WING_INNER)

interface Spark {
  thread: number
  t: number
  speed: number
  size: number
}

let sparkSeed = 11
const random = (): number => {
  sparkSeed = (sparkSeed * 16807) % 2147483647
  return (sparkSeed - 1) / 2147483646
}
const newSpark = (fresh = false): Spark => {
  const forward = random() < 0.7
  return {
    thread: Math.floor(random() * THREADS.length),
    t: fresh ? random() : forward ? 0 : 1,
    speed: (forward ? 1 : -1) * (0.12 + random() * 0.22),
    size: 0.8 + random() * 1.6
  }
}
const sparks: Spark[] = Array.from({ length: 70 }, () => newSpark(true))
const trail: Point[] = []

function logo(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${BIRD_SIZE.width} ${BIRD_SIZE.height}`)
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('logo')
  svg.innerHTML = `
    <defs>
      <linearGradient id="logo-body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1d4ed8"/><stop offset="0.6" stop-color="#38bdf8"/><stop offset="1" stop-color="#a5f3fc"/></linearGradient>
      <linearGradient id="logo-wing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
    </defs>
    <path d="${BIRD_FAR_WING}" fill="#1e3a8a"/>
    <path d="${BIRD_BODY}" fill="url(#logo-body)"/>
    <path d="${BIRD_NEAR_WING_INNER}" fill="url(#logo-body)" opacity="0.85"/>
    <path d="${BIRD_NEAR_WING}" fill="url(#logo-wing)"/>`
  return svg
}
document.querySelector('#wordmark')?.prepend(logo())

function resize(): void {
  if (canvas === null || context === null || context === undefined) return
  const scale = window.devicePixelRatio || 1
  canvas.width = CARD.width * scale
  canvas.height = CARD.height * scale
  context.setTransform(scale, 0, 0, scale, 0, 0)
}

function strokePoints(ctx: CanvasRenderingContext2D, points: Point[]): void {
  const [first, ...rest] = points
  if (first === undefined) return
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (const point of rest) ctx.lineTo(point.x, point.y)
  ctx.stroke()
}

/** A glowing half-circle base: the stream leaves one, and arrives at the other. */
function drawBase(ctx: CanvasRenderingContext2D, at: Point, facing: number, pulse: number, breathing: number): void {
  const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 90)
  glow.addColorStop(0, `rgba(96, 165, 250, ${0.3 + 0.25 * pulse})`)
  glow.addColorStop(0.45, `rgba(59, 130, 246, ${0.1 + 0.1 * pulse})`)
  glow.addColorStop(1, 'rgba(59, 130, 246, 0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(at.x, at.y, 90, 0, Math.PI * 2)
  ctx.fill()

  const from = facing + Math.PI / 2
  const to = facing + (Math.PI * 3) / 2
  ctx.lineCap = 'round'
  for (const [radius, width, alpha] of [
    [34, 3, 0.95],
    [46 + pulse * 10, 1.5, 0.35 * (1 - pulse * 0.5)],
    [60 + pulse * 18, 1, 0.16 * (1 - pulse * 0.6)]
  ] as const) {
    ctx.strokeStyle = `rgba(125, 211, 252, ${alpha * (0.85 + 0.15 * breathing)})`
    ctx.lineWidth = width
    ctx.shadowColor = '#38bdf8'
    ctx.shadowBlur = radius === 34 ? 18 + pulse * 14 : 0
    ctx.beginPath()
    ctx.arc(at.x, at.y, radius, from, to)
    ctx.stroke()
  }
  ctx.shadowBlur = 0

  // A bright core the band emerges from.
  const core = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 30)
  core.addColorStop(0, `rgba(240, 249, 255, ${0.85 + 0.15 * pulse})`)
  core.addColorStop(0.4, `rgba(125, 211, 252, ${0.45 + 0.2 * pulse})`)
  core.addColorStop(1, 'rgba(56, 189, 248, 0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(at.x, at.y, 30, 0, Math.PI * 2)
  ctx.fill()
}

function drawBird(ctx: CanvasRenderingContext2D, at: Point, heading: number, size: number, beat: number): void {
  const facingLeft = Math.cos(heading) < 0
  ctx.save()
  ctx.translate(at.x, at.y)
  ctx.rotate(facingLeft ? heading + Math.PI : heading)
  ctx.scale((facingLeft ? -1 : 1) * size, size)
  ctx.translate(-62, -38)
  ctx.shadowColor = 'rgba(56, 189, 248, 0.9)'
  ctx.shadowBlur = 22

  ctx.fillStyle = '#1e3a8a'
  ctx.fill(farWingPath)

  const body = ctx.createLinearGradient(0, 0, BIRD_SIZE.width, 0)
  body.addColorStop(0, '#1d4ed8')
  body.addColorStop(0.6, '#38bdf8')
  body.addColorStop(1, '#e0f2fe')
  ctx.fillStyle = body
  ctx.fill(bodyPath)
  // A thin light edge keeps the bird readable against the bright threads.
  ctx.strokeStyle = 'rgba(224, 242, 254, 0.75)'
  ctx.lineWidth = 1.1
  ctx.stroke(bodyPath)

  ctx.save()
  ctx.translate(BIRD_SHOULDER.x, BIRD_SHOULDER.y)
  ctx.rotate(beat * 0.32)
  ctx.scale(1, 1 - Math.abs(beat) * 0.18)
  ctx.translate(-BIRD_SHOULDER.x, -BIRD_SHOULDER.y)
  ctx.globalAlpha = 0.85
  ctx.fill(innerWingPath)
  ctx.globalAlpha = 1
  const wing = ctx.createLinearGradient(20, 0, 90, 45)
  wing.addColorStop(0, '#818cf8')
  wing.addColorStop(1, '#67e8f9')
  ctx.fillStyle = wing
  ctx.fill(nearWingPath)
  ctx.stroke(nearWingPath)
  ctx.restore()

  ctx.shadowBlur = 0
  ctx.fillStyle = '#0b1026'
  ctx.beginPath()
  ctx.arc(BIRD_EYE.x, BIRD_EYE.y, BIRD_EYE.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

let started = 0
let previous = 0

function frame(now: number): void {
  if (context === null || context === undefined) return
  const ctx = context
  if (started === 0) {
    started = now
    previous = now
  }
  const elapsed = now - started
  const dt = Math.min(0.05, (now - previous) / 1000)
  previous = now
  const time = reducedMotion ? 1.1 : elapsed / 1000

  const progress = Math.min(1, elapsed / DURATION_MS)
  const shown = 0.04 + 0.96 * easeInOut(progress)
  if (fill !== null) fill.style.width = `${(shown * 100).toFixed(1)}%`
  bar?.setAttribute('aria-valuenow', String(Math.round(shown * 100)))
  if (statusText !== null) {
    const status = statusFor(progress)
    if (statusText.textContent !== status) statusText.textContent = status
  }

  ctx.clearRect(0, 0, CARD.width, CARD.height)
  ctx.globalCompositeOperation = 'lighter'

  // A soft glow under the whole stream.
  const centreLine = Array.from({ length: SAMPLES }, (_, i) => centre(i / (SAMPLES - 1)))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [width, alpha] of [
    [70, 0.035],
    [34, 0.05]
  ] as const) {
    ctx.strokeStyle = `rgba(59, 130, 246, ${alpha})`
    ctx.lineWidth = width
    strokePoints(ctx, centreLine)
  }

  // The threads: woven at the ends, parted into branches in the middle.
  // Drawn in sections so each can fade towards the bases.
  const SECTIONS = 10
  for (const thread of THREADS) {
    const points = Array.from({ length: SAMPLES }, (_, i) => threadPoint(thread, i / (SAMPLES - 1), time))
    ctx.strokeStyle = thread.colour
    const per = Math.ceil(SAMPLES / SECTIONS)
    for (let section = 0; section < SECTIONS; section++) {
      const slice = points.slice(Math.max(0, section * per - 1), (section + 1) * per)
      const fade = endFade((section + 0.5) / SECTIONS)
      ctx.globalAlpha = thread.alpha * 0.22 * fade
      ctx.lineWidth = thread.width * 3.4
      strokePoints(ctx, slice)
      ctx.globalAlpha = thread.alpha * fade
      ctx.lineWidth = thread.width
      strokePoints(ctx, slice)
    }
  }
  ctx.globalAlpha = 1

  // Sparks drifting along the threads, mostly towards the server.
  for (const [index, spark] of sparks.entries()) {
    if (!reducedMotion) spark.t += spark.speed * dt
    if (spark.t < 0 || spark.t > 1) {
      sparks[index] = newSpark()
      continue
    }
    const thread = THREADS[spark.thread]
    if (thread === undefined) continue
    const at = threadPoint(thread, spark.t, time)
    const fade = Math.sin(Math.PI * spark.t)
    const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, spark.size * 4)
    glow.addColorStop(0, `rgba(224, 242, 254, ${0.9 * fade})`)
    glow.addColorStop(0.35, `rgba(125, 211, 252, ${0.45 * fade})`)
    glow.addColorStop(1, 'rgba(56, 189, 248, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(at.x, at.y, spark.size * 4, 0, Math.PI * 2)
    ctx.fill()
  }

  const clock = reducedMotion ? 1100 : elapsed
  const startFacing = Math.atan2(tangent(0).y, tangent(0).x)
  const endFacing = Math.atan2(tangent(1).y, tangent(1).x) + Math.PI
  const breathing = Math.sin(time * 2.4)
  drawBase(ctx, START, startFacing, arrivalPulse(clock, 'start', DURATION_MS), breathing)
  drawBase(ctx, END, endFacing, arrivalPulse(clock, 'end', DURATION_MS), -breathing)

  // The bird, with a fading trail of light behind it.
  const bird = birdAt(clock, DURATION_MS)
  const at = branchPoint(bird.branch, bird.t, time)
  const ahead = branchPoint(bird.branch, Math.min(1, Math.max(0, bird.t + 0.01 * bird.direction)), time)
  const heading =
    ahead.x === at.x && ahead.y === at.y ? Math.atan2(tangent(bird.t).y, tangent(bird.t).x) * 1 + (bird.direction === 1 ? 0 : Math.PI) : Math.atan2(ahead.y - at.y, ahead.x - at.x)
  trail.push(at)
  if (trail.length > 34) trail.shift()
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]
    const b = trail[i]
    if (a === undefined || b === undefined) continue
    ctx.strokeStyle = `rgba(165, 243, 252, ${(i / trail.length) * 0.55})`
    ctx.lineWidth = (i / trail.length) * 7
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
  const atEnd = bird.t === 0 || bird.t === 1
  drawBird(ctx, at, heading, atEnd ? 0.66 : 0.78, reducedMotion ? 0.4 : Math.sin(time * 14))

  requestAnimationFrame(frame)
}

resize()
requestAnimationFrame(frame)
