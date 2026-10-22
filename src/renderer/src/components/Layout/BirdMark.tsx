import type { JSX } from 'react'
import { BIRD_BODY, BIRD_EYE, BIRD_FAR_WING, BIRD_NEAR_WING, BIRD_NEAR_WING_INNER, BIRD_SHOULDER } from '@renderer/splash/bird'

interface BirdMarkProps {
  /** Height in pixels; the width follows the bird's own proportions. */
  height: number
}

/**
 * The BridgeX swallow, as a mark beside the name (user request, 2026-10-19).
 * The same shapes as the Dock icon and the start screen, so the three agree.
 */
export function BirdMark({ height }: BirdMarkProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 120 80"
      height={height}
      role="img"
      aria-label="BridgeX"
      className="block w-auto shrink-0 select-none"
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="birdmark-body" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1d4ed8" />
          <stop offset="0.6" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#e0f2fe" />
        </linearGradient>
        <linearGradient id="birdmark-wing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="1" stopColor="#67e8f9" />
        </linearGradient>
        <linearGradient id="birdmark-farwing" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#312e81" />
        </linearGradient>
      </defs>
      <path d={BIRD_FAR_WING} fill="url(#birdmark-farwing)" transform="rotate(-23.4 78 45)" />
      <path d={BIRD_BODY} fill="url(#birdmark-body)" />
      <g transform={`translate(${BIRD_SHOULDER.x} ${BIRD_SHOULDER.y}) rotate(18) scale(1.1) translate(${-BIRD_SHOULDER.x} ${-BIRD_SHOULDER.y})`}>
        <path d={BIRD_NEAR_WING_INNER} fill="url(#birdmark-body)" opacity="0.85" transform="rotate(-7.2 77 38)" />
        <path d={BIRD_NEAR_WING} fill="url(#birdmark-wing)" />
      </g>
      <circle cx={BIRD_EYE.x} cy={BIRD_EYE.y} r={BIRD_EYE.radius} fill="#0b1026" />
    </svg>
  )
}
