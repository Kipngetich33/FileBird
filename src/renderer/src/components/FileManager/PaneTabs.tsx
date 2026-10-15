import type { JSX } from 'react'
import { MAX_TERMINALS_PER_PANE } from '@shared/constants/terminals'
import { terminalLabel, type TerminalTab } from '@renderer/utils/terminal-tabs'

export type PaneTab = 'files' | 'terminal'

interface PaneTabsProps {
  /** Whether the pane is showing its files or one of its terminals. */
  active: PaneTab
  /** Whether this pane is the one menu commands act on, for the accent colour. */
  paneActive: boolean
  /** The pane's terminals, in tab order; empty until the first one is opened. */
  terminals: readonly TerminalTab[]
  /** Which terminal is on show, when `active` is 'terminal'. */
  activeTerminal: string | null
  onShowFiles: () => void
  onShowTerminal: (key: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (key: string) => void
}

/**
 * Files, then one tab per terminal in the same pane (Milestone 11 plan D1,
 * extended on 2026-10-15 to several terminals: "+" opens another, "×" closes
 * one, and each keeps its own shell and scrollback).
 */
export function PaneTabs({
  active,
  paneActive,
  terminals,
  activeTerminal,
  onShowFiles,
  onShowTerminal,
  onNewTerminal,
  onCloseTerminal
}: PaneTabsProps): JSX.Element {
  const underline = (selected: boolean): string =>
    selected ? (paneActive ? 'border-sky-400 text-sky-200' : 'border-white/30 text-zinc-200') : 'border-transparent text-zinc-500 hover:text-zinc-300'
  const atCap = terminals.length >= MAX_TERMINALS_PER_PANE

  return (
    <div role="tablist" aria-label="Pane view" className="flex h-7 shrink-0 items-stretch gap-1 border-b border-white/[0.06] px-2">
      <button
        role="tab"
        type="button"
        aria-selected={active === 'files'}
        data-testid="tab-files"
        onClick={onShowFiles}
        className={`-mb-px border-b px-2 text-[11px] transition ${underline(active === 'files')}`}
      >
        Files
      </button>

      {/* Before the first one exists, one tab offers it — the pane has always
          had a Terminal tab, and it opens the session when it is first clicked.
          The "+" appears once there is something to add to. */}
      {terminals.length === 0 && (
        <button
          role="tab"
          type="button"
          aria-selected={false}
          data-testid="tab-terminal"
          onClick={onNewTerminal}
          className={`-mb-px border-b px-2 text-[11px] transition ${underline(false)}`}
        >
          Terminal
        </button>
      )}

      {terminals.map((terminal, index) => {
        const selected = active === 'terminal' && terminal.key === activeTerminal
        return (
          // One tab: the name selects it, the × closes it. A nested button would
          // be invalid inside the tab itself, so they sit side by side.
          <span key={terminal.key} className={`-mb-px flex items-center border-b ${underline(selected)}`}>
            <button
              role="tab"
              type="button"
              aria-selected={selected}
              data-testid="tab-terminal"
              data-terminal={terminal.key}
              onClick={() => onShowTerminal(terminal.key)}
              className="px-2 text-[11px] text-inherit transition"
            >
              {terminalLabel(index)}
            </button>
            <button
              type="button"
              aria-label={`Close ${terminalLabel(index)}`}
              title={`Close ${terminalLabel(index)}`}
              data-testid="tab-terminal-close"
              data-terminal={terminal.key}
              onClick={() => onCloseTerminal(terminal.key)}
              className="mr-1 rounded px-1 text-[11px] leading-none text-zinc-600 transition hover:bg-white/10 hover:text-zinc-200"
            >
              ×
            </button>
          </span>
        )
      })}

      <button
        type="button"
        hidden={terminals.length === 0}
        disabled={atCap}
        aria-label="New terminal"
        title={atCap ? `A pane runs up to ${MAX_TERMINALS_PER_PANE} terminals` : 'New terminal'}
        data-testid="tab-terminal-new"
        onClick={onNewTerminal}
        className="-mb-px border-b border-transparent px-2 text-[12px] leading-none text-zinc-600 transition hover:text-zinc-200 disabled:text-zinc-700 disabled:hover:text-zinc-700"
      >
        +
      </button>
    </div>
  )
}
