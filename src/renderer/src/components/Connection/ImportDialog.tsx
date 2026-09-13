import { useEffect, useState, type JSX } from 'react'
import type { ImportPreview } from '@shared/types/connections'
import type { AppErrorPayload } from '@shared/types/errors'
import { connectionsService } from '@renderer/services/connections.service'
import { Dialog, PRIMARY_BUTTON, SECONDARY_BUTTON } from './Dialog'

interface ImportDialogProps {
  onClose: () => void
  onImported: (count: number) => void
}

type State = { name: 'loading' } | { name: 'preview'; preview: ImportPreview } | { name: 'error'; message: string }

/**
 * One-way import from ~/.ssh/config. If the config runs commands while being
 * read (Match exec), nothing is resolved until the user agrees, because
 * resolving hosts with `ssh -G` runs those commands.
 */
export function ImportDialog({ onClose, onImported }: ImportDialogProps): JSX.Element {
  const [state, setState] = useState<State>({ name: 'loading' })
  const [allowCommands, setAllowCommands] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    let current = true
    setState({ name: 'loading' })
    connectionsService
      .previewImport(allowCommands)
      .then((preview) => {
        if (!current) return
        setState({ name: 'preview', preview })
        if (preview.status === 'ready') {
          // Hosts with warnings (e.g. a jump host) start unticked: importing one is a deliberate choice.
          setSelected(new Set(preview.candidates.filter((c) => !c.alreadyImported && c.warnings.length === 0).map((c) => c.alias)))
        }
      })
      .catch((cause: AppErrorPayload) => current && setState({ name: 'error', message: cause.message }))
    return () => {
      current = false
    }
  }, [allowCommands])

  async function runImport(): Promise<void> {
    setImporting(true)
    try {
      const created = await connectionsService.importHosts([...selected], allowCommands)
      onImported(created.length)
    } catch (cause) {
      setState({ name: 'error', message: (cause as AppErrorPayload).message })
    } finally {
      setImporting(false)
    }
  }

  const preview = state.name === 'preview' ? state.preview : null
  const toggle = (alias: string): void =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })

  let actions: JSX.Element
  if (preview?.status === 'needs-consent') {
    actions = (
      <>
        <button type="button" data-autofocus onClick={onClose} className={SECONDARY_BUTTON}>
          Cancel
        </button>
        <button type="button" onClick={() => setAllowCommands(true)} className={PRIMARY_BUTTON}>
          Run them and continue
        </button>
      </>
    )
  } else if (preview?.status === 'ready' && preview.candidates.length > 0) {
    actions = (
      <>
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          Cancel
        </button>
        <button type="button" disabled={selected.size === 0 || importing} onClick={() => void runImport()} className={PRIMARY_BUTTON}>
          {importing ? 'Importing…' : `Import ${selected.size}`}
        </button>
      </>
    )
  } else {
    actions = (
      <button type="button" data-autofocus onClick={onClose} className={SECONDARY_BUTTON}>
        Close
      </button>
    )
  }

  return (
    <Dialog title="Import from SSH config" onDismiss={onClose} actions={actions}>
      {state.name === 'loading' && <p>Reading your SSH config…</p>}
      {state.name === 'error' && (
        <p role="alert" className="text-red-300">
          {state.message}
        </p>
      )}

      {preview?.status === 'no-config' && <p>There's no SSH config at <span className="font-mono">{preview.configPath}</span>.</p>}

      {preview?.status === 'needs-consent' && (
        <div data-testid="import-consent" className="space-y-2">
          <p>
            Your SSH config at <span className="font-mono">{preview.configPath}</span> runs{' '}
            {preview.commands === 1 ? 'a command' : `${preview.commands} commands`} while it is read (
            <span className="font-mono">Match exec</span>).
          </p>
          <p>
            Reading host settings runs {preview.commands === 1 ? 'it' : 'them'}, exactly as every <span className="font-mono">ssh</span>{' '}
            command does. Nothing has run yet.
          </p>
        </div>
      )}

      {preview?.status === 'ready' && preview.candidates.length === 0 && <p>No hosts to import were found.</p>}

      {preview?.status === 'ready' && preview.candidates.length > 0 && (
        <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          <p className="text-[11px] text-zinc-500">
            Imported hosts become ordinary saved connections you can edit. Later changes to the config aren't synced.
          </p>
          {preview.candidates.map((candidate) => (
            <label
              key={candidate.alias}
              data-import-alias={candidate.alias}
              className={`flex items-start gap-2 rounded-md border border-white/[0.07] px-2.5 py-2 ${candidate.alreadyImported ? 'opacity-50' : ''}`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={candidate.alreadyImported}
                checked={selected.has(candidate.alias)}
                onChange={() => toggle(candidate.alias)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-zinc-100">{candidate.alias}</span>
                  {candidate.alreadyImported && <span className="text-[10px] text-zinc-500">already added</span>}
                </span>
                <span className="block truncate font-mono text-[11px] text-zinc-500">
                  {candidate.username}@{candidate.host}
                  {candidate.port === 22 ? '' : `:${candidate.port}`}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {candidate.privateKeyPath === null
                    ? 'Password login'
                    : `Key: ${candidate.privateKeyPath}${candidate.keySource === 'default' ? ' (default)' : ''}`}
                </span>
                {candidate.warnings.map((warning) => (
                  <span key={warning} className="block text-[11px] text-amber-300/90">
                    {warning}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </div>
      )}
    </Dialog>
  )
}
