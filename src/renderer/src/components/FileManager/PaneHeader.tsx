import type { JSX, ReactNode } from 'react'

interface PaneHeaderProps {
  title: string
  /** e.g. the user@host of a remote pane. */
  subtitle?: string
  path: string | null
  loading: boolean
  canGoBack: boolean
  canGoUp: boolean
  onBack: () => void
  onUp: () => void
  onRefresh: () => void
  /** Pane-specific controls at the right end, such as Disconnect. */
  actions?: ReactNode
}

export function PaneHeader({
  title,
  subtitle,
  path,
  loading,
  canGoBack,
  canGoUp,
  onBack,
  onUp,
  onRefresh,
  actions
}: PaneHeaderProps): JSX.Element {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-white/[0.06] px-3">
      <span className="flex shrink-0 items-baseline gap-2">
        <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</span>
        {subtitle !== undefined && (
          <span data-testid="pane-subtitle" className="max-w-40 truncate text-[11px] text-zinc-400">
            {subtitle}
          </span>
        )}
      </span>

      <div className="flex items-center gap-0.5">
        <ToolbarButton label="Back" disabled={!canGoBack} onClick={onBack}>
          <path d="M10 3.5 5.5 8l4.5 4.5" />
        </ToolbarButton>
        <ToolbarButton label="Parent folder" disabled={!canGoUp} onClick={onUp}>
          <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" />
        </ToolbarButton>
        <ToolbarButton label="Refresh" disabled={path === null} onClick={onRefresh}>
          <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" />
        </ToolbarButton>
      </div>

      <span
        data-testid="pane-path"
        title={path ?? undefined}
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300 select-text"
      >
        {path ?? ''}
      </span>

      {loading && <span className="shrink-0 text-[11px] text-zinc-500">Loading…</span>}
      {actions}
    </div>
  )
}

interface ToolbarButtonProps {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}

function ToolbarButton({ label, disabled, onClick, children }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-30"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
