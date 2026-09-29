import { useEffect, useRef, useState, type JSX } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { AppErrorPayload } from '@shared/types/errors'
import { terminalsService } from '@renderer/services/terminals.service'

/**
 * How much drawn output to report at a time. It must stay below the mark at
 * which the main process lets a paused shell continue, or a flood would never
 * start flowing again.
 */
const ACK_EVERY_CHARS = 5_000

/** Lines kept above the top of the window, per session. */
const SCROLLBACK = 5_000

/** Matches the app's panes, so a terminal doesn't look like a hole in the window. */
const THEME = {
  background: '#0b0d12',
  foreground: '#e4e4e7',
  cursor: '#38bdf8',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(56, 189, 248, 0.32)',
  black: '#11141b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
}

export interface TerminalViewProps {
  /** Which shell to open. A remote terminal needs the live connection's id. */
  side: 'local' | 'remote'
  connectionId?: string
  /** The folder to start in; the session keeps its own from then on. */
  cwd: string | null
  /** A hidden terminal keeps its session and scrollback; showing it again refits. */
  visible: boolean
}

/**
 * One terminal (Milestone 11): xterm.js in the page, the shell itself in the
 * main process. Bytes travel both ways, because decoding halfway would break
 * any character split across two chunks.
 */
export function TerminalView({ side, connectionId, cwd, visible }: TerminalViewProps): JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const refit = useRef<() => void>(() => undefined)
  const focus = useRef<() => void>(() => undefined)

  useEffect(() => {
    const container = holder.current
    if (container === null) return

    const terminal = new Terminal({
      allowProposedApi: false,
      // The server may not resize or retitle the window, and may not write the clipboard.
      windowOptions: {},
      scrollback: SCROLLBACK,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      theme: THEME
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)

    let disposed = false
    let sessionId: string | null = null
    let acked = 0
    const sinceAck = { chars: 0 }

    const sizeNow = (): { cols: number; rows: number } => {
      const proposed = fit.proposeDimensions()
      return { cols: proposed?.cols ?? terminal.cols, rows: proposed?.rows ?? terminal.rows }
    }

    const fitToBox = (): void => {
      // A hidden or not-yet-laid-out box has no usable size to fit to.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        // Fitting a terminal that is going away is not worth reporting.
      }
    }
    refit.current = fitToBox
    focus.current = () => terminal.focus()
    fitToBox()

    const stopData = terminalsService.onData((event) => {
      if (event.id !== sessionId) return
      // xterm keeps its decoder's state between writes, so a character split
      // across two chunks still arrives whole.
      terminal.write(event.data, () => {
        sinceAck.chars += event.data.length
        if (sinceAck.chars < ACK_EVERY_CHARS || sessionId === null) return
        acked = sinceAck.chars
        sinceAck.chars = 0
        void terminalsService.acknowledge(sessionId, acked)
      })
    })

    const stopExit = terminalsService.onExit((event) => {
      if (event.id !== sessionId) return
      sessionId = null
      setEnded(true)
      const how = event.signal !== null ? `signal ${event.signal}` : event.code !== null ? `status ${event.code}` : 'closed'
      terminal.write(`\r\n\x1b[38;5;245m[session ended: ${how}]\x1b[0m\r\n`)
    })

    const typed = terminal.onData((data) => {
      if (sessionId !== null) void terminalsService.write(sessionId, new TextEncoder().encode(data))
    })
    const typedBinary = terminal.onBinary((data) => {
      if (sessionId === null) return
      const bytes = new Uint8Array(data.length)
      for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff
      void terminalsService.write(sessionId, bytes)
    })
    const resized = terminal.onResize(({ cols, rows }) => {
      if (sessionId !== null) void terminalsService.resize(sessionId, cols, rows)
    })

    const observer = new ResizeObserver(() => fitToBox())
    observer.observe(container)

    const { cols, rows } = sizeNow()
    void terminalsService
      .open({ side, ...(connectionId === undefined ? {} : { connectionId }), ...(cwd === null ? {} : { cwd }), cols, rows })
      .then((id) => {
        if (disposed) {
          void terminalsService.close(id)
          return
        }
        sessionId = id
        setError(null)
        setEnded(false)
        // The box may have settled between asking and answering.
        fitToBox()
        terminal.focus()
      })
      .catch((cause: AppErrorPayload) => {
        if (disposed) return
        setError(cause.message)
      })

    // The menu's file commands give up their keys while the terminal has focus.
    const onFocusIn = (): void => void terminalsService.setFocus(true)
    const onFocusOut = (): void => void terminalsService.setFocus(false)
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)

    return () => {
      disposed = true
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      void terminalsService.setFocus(false)
      observer.disconnect()
      stopData()
      stopExit()
      typed.dispose()
      typedBinary.dispose()
      resized.dispose()
      if (sessionId !== null) void terminalsService.close(sessionId)
      terminal.dispose()
    }
  }, [side, connectionId, cwd, attempt])

  useEffect(() => {
    if (!visible) return
    // A terminal that was hidden has no size; it is fitted once it is shown again.
    const frame = requestAnimationFrame(() => {
      refit.current()
      focus.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#0b0d12]" data-testid={`terminal-${side}`} data-ended={ended || undefined}>
      <div ref={holder} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
      {error !== null && (
        <div role="alert" className="border-t border-red-500/15 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}
      {ended && error === null && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] px-3 py-1.5 text-[11px] text-zinc-400">
          <span>This session has ended.</span>
          <button
            type="button"
            data-testid="terminal-restart"
            onClick={() => setAttempt((count) => count + 1)}
            className="rounded border border-white/10 px-2 py-0.5 text-zinc-300 transition hover:border-sky-500/40 hover:text-sky-200"
          >
            Start again
          </button>
        </div>
      )}
    </div>
  )
}
