import type { JSX, ReactNode } from 'react'

interface PaneHeaderProps {
  title: string
  /** e.g. the user@host of a remote pane. */
  subtitle?: string
  active: boolean
  path: string | null
  loading: boolean
  canGoBack: boolean
  canGoUp: boolean
  onBack: () => void
  onUp: () => void
  onRefresh: () => void
  /** Absent when the pane can't create folders. */
  onNewFolder?: () => void
  /** Opens this pane's search box. */
  onSearch: () => void
  /** Whether the search box is open, so the button reads as pressed. */
  searching: boolean
  /** Pane-specific controls at the right end, such as Disconnect. */
  actions?: ReactNode
}

export function PaneHeader({
  title,
  subtitle,
  active,
  path,
  loading,
  canGoBack,
  canGoUp,
  onBack,
  onUp,
  onRefresh,
  onNewFolder,
  onSearch,
  searching,
  actions
}: PaneHeaderProps): JSX.Element {
  return (
    // A container, so a narrow pane can drop the user@host label (also shown in the title and status bars).
    <div className="@container flex h-10 shrink-0 items-center gap-3 border-b border-white/[0.06] px-3">
      <span className="flex min-w-0 shrink-0 items-baseline gap-2">
        <span
          className={`text-[10px] font-semibold tracking-wider uppercase transition-colors ${active ? 'text-sky-300' : 'text-zinc-500'}`}
        >
          {title}
        </span>
        {subtitle !== undefined && (
          <span data-testid="pane-subtitle" title={subtitle} className="hidden max-w-32 truncate text-[11px] text-zinc-400 @md:inline-block">
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
        <ToolbarButton label="Refresh" disabled={path === null} spinning={loading} onClick={onRefresh}>
          <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" />
        </ToolbarButton>
        {onNewFolder !== undefined && (
          <ToolbarButton label="New folder" disabled={path === null} onClick={onNewFolder}>
            <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM8 7.5v3.5M6.25 9.25h3.5" />
          </ToolbarButton>
        )}
        <ToolbarButton label="Search this folder" disabled={path === null} pressed={searching} onClick={onSearch}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </ToolbarButton>
      </div>

      {/* Truncates at the start, so the current folder's name stays visible: …/fixture/alpha */}
      <span
        data-testid="pane-path"
        title={path ?? undefined}
        dir="rtl"
        className="min-w-16 flex-1 truncate text-left font-mono text-[11px] text-zinc-300 select-text"
      >
        <bdi dir="ltr">{path ?? ''}</bdi>
      </span>

      {/* The Refresh icon spins; the words are for screen readers, so a narrow header never loses its buttons. */}
      {loading && (
        <span role="status" className="sr-only">
          Loading…
        </span>
      )}
      {actions}
    </div>
  )
}

interface ToolbarButtonProps {
  label: string
  disabled: boolean
  spinning?: boolean
  /** A button that stays on while its panel is open. */
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}

function ToolbarButton({ label, disabled, spinning = false, pressed, onClick, children }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
      className={`inline-flex h-6 w-6 items-center justify-center rounded transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-30 ${
        pressed === true ? 'bg-white/[0.08] text-sky-300' : 'text-zinc-400'
      }`}
    >
      <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 fill-none stroke-current stroke-[1.6] ${spinning ? 'animate-spin' : ''}`} aria-hidden>
        {children}
      </svg>
    </button>
  )
}
