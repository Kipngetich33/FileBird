import type { JSX } from 'react'

export type PaneTab = 'files' | 'terminal'

interface PaneTabsProps {
  active: PaneTab
  /** Whether this pane is the one menu commands act on, for the accent colour. */
  paneActive: boolean
  onChange: (tab: PaneTab) => void
}

const TABS: Array<{ id: PaneTab; label: string }> = [
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' }
]

/** Files or a terminal, in the same pane (Milestone 11 plan D1). */
export function PaneTabs({ active, paneActive, onChange }: PaneTabsProps): JSX.Element {
  return (
    <div role="tablist" aria-label="Pane view" className="flex h-7 shrink-0 items-stretch gap-1 border-b border-white/[0.06] px-2">
      {TABS.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            data-testid={`tab-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`-mb-px border-b px-2 text-[11px] transition ${
              selected
                ? `${paneActive ? 'border-sky-400 text-sky-200' : 'border-white/30 text-zinc-200'}`
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
