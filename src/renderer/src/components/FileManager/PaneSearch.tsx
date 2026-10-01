import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'

interface PaneSearchProps {
  /** Which pane this is, so each box is labelled for itself. */
  label: string
  value: string
  /** How many of the folder's items the search leaves, for the message when none do. */
  matches: number
  onChange: (value: string) => void
  /** Enter: done typing — the list takes over, with the first match selected. */
  onCommit: () => void
  /** Escape, or the clear button: back to the whole folder. */
  onClose: () => void
}

/**
 * Narrows a pane to the items whose name contains what you type (Milestone 12).
 * It filters as you type; Enter hands the list back the keyboard, Escape clears.
 */
export function PaneSearch({ label, value, matches, onChange, onCommit, onClose }: PaneSearchProps): JSX.Element {
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // The pane's own shortcuts must not fire while someone is typing a name.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onCommit()
    }
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-zinc-500 stroke-[1.6]" aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </svg>
      <input
        ref={field}
        type="text"
        name="pane-search"
        role="searchbox"
        aria-label={`Search ${label}`}
        data-testid="pane-search"
        placeholder="Filter this folder"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
      />
      {value.trim() !== '' && (
        <span data-testid="search-matches" className="shrink-0 text-[11px] text-zinc-500">
          {matches === 0 ? 'nothing matches' : `${matches} ${matches === 1 ? 'match' : 'matches'}`}
        </span>
      )}
      <button
        type="button"
        aria-label="Close search"
        data-testid="search-close"
        onClick={onClose}
        className="shrink-0 rounded px-1 text-[13px] leading-none text-zinc-500 transition hover:text-zinc-200"
      >
        ×
      </button>
    </div>
  )
}
