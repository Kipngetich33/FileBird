import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { DEFAULT_SPLIT, clampSplit, readStoredSplit, safeLocalStorage, splitBounds, storeSplit } from '@renderer/utils/split'

/** Width of the draggable gap between the panes. */
const GUTTER_PX = 12

interface SplitLayoutProps {
  left: ReactNode
  right: ReactNode
}

/**
 * Two panes with a draggable divider. Drag it, use ←/→ (Shift for bigger
 * steps) or Home/End when it has focus, or double-click to return to 50/50.
 * The position is remembered between launches.
 */
export function SplitLayout({ left, right }: SplitLayoutProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const [split, setSplit] = useState(() => readStoredSplit(safeLocalStorage()))
  const dragging = useRef(false)

  // Track the width the panes share, so limits follow window resizes.
  useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const measure = (): void => setAvailable(element.clientWidth - GUTTER_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const effective = available > 0 ? clampSplit(split, available) : split
  const bounds = splitBounds(available)

  const commit = useCallback(
    (next: number) => {
      const clamped = clampSplit(next, available)
      setSplit(clamped)
      storeSplit(safeLocalStorage(), clamped)
    },
    [available]
  )

  const fromPointer = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect === undefined || available <= 0) return effective
    return ((clientX - rect.left - GUTTER_PX / 2) / available) * 100
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragging.current) setSplit(clampSplit(fromPointer(event.clientX), available))
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (!dragging.current) return
    dragging.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    commit(fromPointer(event.clientX))
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 10 : 2
    const next =
      event.key === 'ArrowLeft' ? effective - step
      : event.key === 'ArrowRight' ? effective + step
      : event.key === 'Home' ? bounds.min
      : event.key === 'End' ? bounds.max
      : null
    if (next === null) return
    event.preventDefault()
    commit(next)
  }

  // Keep the stored value within limits if it was saved on a wider window.
  useEffect(() => {
    if (available > 0 && effective !== split) setSplit(effective)
  }, [available, effective, split])

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0" style={{ width: `calc((100% - ${GUTTER_PX}px) * ${effective / 100})` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuenow={Math.round(effective)}
        aria-valuemin={Math.round(bounds.min)}
        aria-valuemax={Math.round(bounds.max)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => commit(DEFAULT_SPLIT)}
        onKeyDown={onKeyDown}
        className="group flex shrink-0 cursor-col-resize items-center justify-center outline-none"
        style={{ width: GUTTER_PX }}
      >
        <span className="h-10 w-0.5 rounded-full bg-white/[0.08] transition group-hover:bg-sky-400/60 group-focus-visible:bg-sky-400" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  )
}
