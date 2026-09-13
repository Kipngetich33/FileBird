import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { baseNameLength, nameProblem } from '@shared/names'
import { Dialog, PRIMARY_BUTTON, SECONDARY_BUTTON } from '@renderer/components/Connection/Dialog'

interface NameDialogProps {
  title: string
  confirmLabel: string
  initial: string
  /** Rename preselects the name without its extension; a folder name is selected whole. */
  isFolder: boolean
  /** Naming rules: this computer's platform locally, POSIX on the server. */
  platform: string
  busy: boolean
  /** From the main process, e.g. the name is already taken. */
  error: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}

/** Asks for a file or folder name, explaining problems as it is typed (Milestone 8). */
export function NameDialog({ title, confirmLabel, initial, isFolder, platform, busy, error, onSubmit, onCancel }: NameDialogProps): JSX.Element {
  const [name, setName] = useState(initial)
  const [edited, setEdited] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const problem = nameProblem(name, platform)
  const unchanged = name === initial && initial !== ''

  // After Dialog focuses the field: select the part people usually change.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(0, baseNameLength(initial, isFolder))
  }, [initial, isFolder])

  function submit(event: FormEvent): void {
    event.preventDefault()
    setEdited(true)
    if (busy || problem !== null) return
    if (unchanged) {
      onCancel()
      return
    }
    onSubmit(name)
  }

  const message = error ?? (edited || name !== initial ? problem : null)

  return (
    <Dialog
      title={title}
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="submit" form="name-dialog" disabled={busy || problem !== null} className={PRIMARY_BUTTON}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <form id="name-dialog" onSubmit={submit} className="space-y-2">
        <input
          ref={inputRef}
          name="item-name"
          data-autofocus
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setEdited(true)
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label="Name"
          aria-invalid={message !== null}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-sky-500/60"
        />
        {message !== null && (
          <p role="alert" data-testid="name-problem" className="text-[11px] text-red-300">
            {message}
          </p>
        )}
      </form>
    </Dialog>
  )
}
