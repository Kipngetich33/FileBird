import { useState, type JSX, type KeyboardEvent, type Ref } from 'react'
import type { ConnectionSummary } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'

interface ConnectionListProps {
  profiles: ConnectionSummary[]
  loading: boolean
  busy: boolean
  error: AppErrorPayload | null
  notice: string | null
  onConnect: (profile: ConnectionSummary) => void
  onEdit: (profile: ConnectionSummary) => void
  onDelete: (profile: ConnectionSummary) => void
  onForgetSecret: (profile: ConnectionSummary) => void
  onNew: () => void
  onImport: () => void
  onDismissError: () => void
  /** Tab / Shift+Tab from the list moves to the other pane. */
  onSwitchPane: () => void
  listRef?: Ref<HTMLDivElement>
}

const SMALL_BUTTON =
  'rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-100 disabled:opacity-40'

function target(profile: ConnectionSummary): string {
  return `${profile.username}@${profile.host}${profile.port === 22 ? '' : `:${profile.port}`}`
}

/** Saved connections (spec section 8). Double-click or Enter connects. */
export function ConnectionList(props: ConnectionListProps): JSX.Element {
  const { profiles, loading, busy, error, notice } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Tab') {
      if (event.target === event.currentTarget) {
        event.preventDefault()
        props.onSwitchPane()
      }
      return
    }
    if (event.target instanceof HTMLButtonElement) return
    const index = profiles.findIndex((profile) => profile.id === selectedId)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (profiles.length === 0) return
      const next = index === -1 ? 0 : Math.min(profiles.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
      setSelectedId(profiles[next]?.id ?? null)
    } else if (event.key === 'Enter' && selected !== null && !busy) {
      event.preventDefault()
      props.onConnect(selected)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
      event.preventDefault()
      props.onDelete(selected)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-zinc-100">Connections</h2>
          <p className="mt-0.5 text-[12px] text-zinc-500">Saved servers. Passwords and passphrases live in your keychain.</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={props.onImport} className={SMALL_BUTTON}>
            Import from SSH config
          </button>
          <button type="button" onClick={props.onNew} className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-sky-500">
            New connection
          </button>
        </div>
      </div>

      {error !== null && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300">
          <span className="select-text">{error.message}</span>
          <button type="button" onClick={props.onDismissError} className="shrink-0 text-[11px] text-red-300/70 hover:text-red-200">
            Dismiss
          </button>
        </div>
      )}

      {notice !== null && (
        <p role="status" className="rounded-md border border-sky-500/20 bg-sky-500/[0.07] px-3 py-2 text-[12px] text-sky-200">
          {notice}
        </p>
      )}

      {!loading && profiles.length === 0 ? (
        <p className="rounded-md border border-dashed border-white/10 px-4 py-8 text-center text-[12px] text-zinc-500">
          No saved connections yet. Add one, or import hosts from your SSH config.
        </p>
      ) : (
        <div
          ref={props.listRef}
          role="listbox"
          aria-label="Saved connections"
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="overflow-hidden rounded-md border border-white/[0.07] outline-none focus:border-white/[0.14]"
        >
          {profiles.map((profile) => {
            const isSelected = profile.id === selectedId
            return (
              <div
                key={profile.id}
                role="option"
                aria-selected={isSelected}
                data-connection-name={profile.name}
                onClick={() => setSelectedId(profile.id)}
                onDoubleClick={() => !busy && props.onConnect(profile)}
                className={`flex items-center gap-3 border-b border-white/[0.04] px-3 py-2 last:border-b-0 ${
                  isSelected ? 'bg-sky-500/15' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-zinc-100">{profile.name}</span>
                    <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-[10px] text-zinc-400">
                      {profile.auth.type === 'privateKey' ? 'Key' : 'Password'}
                    </span>
                    {profile.savedSecret !== null && (
                      <span data-testid="saved-secret" className="shrink-0 text-[10px] text-emerald-300/80">
                        {profile.savedSecret} saved
                      </span>
                    )}
                    {profile.importedFrom !== undefined && (
                      <span className="shrink-0 text-[10px] text-zinc-500">from SSH config</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-zinc-500">{target(profile)}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" disabled={busy} onClick={() => props.onConnect(profile)} className={SMALL_BUTTON}>
                    Connect
                  </button>
                  {profile.savedSecret !== null && (
                    <button type="button" onClick={() => props.onForgetSecret(profile)} className={SMALL_BUTTON}>
                      Forget {profile.savedSecret}
                    </button>
                  )}
                  <button type="button" onClick={() => props.onEdit(profile)} className={SMALL_BUTTON}>
                    Edit
                  </button>
                  <button type="button" onClick={() => props.onDelete(profile)} className={SMALL_BUTTON}>
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {busy && <p className="text-[11px] text-zinc-500">Connecting…</p>}
    </div>
  )
}
