import type { JSX } from 'react'
import type { FileFacts } from '@shared/types/transfers'
import { DANGER_BUTTON, Dialog, PRIMARY_BUTTON, SECONDARY_BUTTON } from '@renderer/components/Connection/Dialog'
import type { PendingConflict } from '@renderer/hooks/useTransferQueue'
import { formatModified, formatSize } from '@renderer/utils/file-entries'

interface ConflictDialogProps {
  conflict: PendingConflict
  onReplace: () => void
  onKeepBoth: () => void
  onSkip: () => void
  onCancel: () => void
}

const NAMES_SHOWN = 5

/**
 * Names that already exist at the destination (Milestone 7 plan D2). Cancel is
 * focused, so Enter never replaces anything; nothing has been touched yet.
 */
export function ConflictDialog({ conflict, onReplace, onKeepBoth, onSkip, onCancel }: ConflictDialogProps): JSX.Element {
  const { conflicts, conflictCount, itemCount, request } = conflict
  const [first] = conflicts
  const single = conflictCount === 1 && first !== undefined
  const where = request.direction === 'upload' ? 'on the server' : 'on this computer'
  const replaceable = conflicts.some((item) => item.canReplace)
  const folders = conflicts.some((item) => item.canReplace && item.existing.isDirectory)
  // Skip only means something when some items don't conflict.
  const canSkip = itemCount > conflictCount

  return (
    <Dialog
      title={single ? `"${first.name}" already exists` : `${conflictCount} items already exist`}
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" data-autofocus onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          {canSkip && (
            <button type="button" onClick={onSkip} className={SECONDARY_BUTTON}>
              Skip
            </button>
          )}
          <button type="button" onClick={onKeepBoth} className={replaceable ? SECONDARY_BUTTON : PRIMARY_BUTTON}>
            Keep both
          </button>
          {replaceable && (
            <button type="button" onClick={onReplace} className={DANGER_BUTTON}>
              Replace
            </button>
          )}
        </>
      }
    >
      <p>
        {single ? (first.existing.isDirectory ? 'A folder' : 'A file') : 'Items'} with {single ? 'this name already exists' : 'these names already exist'} in{' '}
        <span className="font-mono text-zinc-300">{request.destinationDirectory}</span> {where}.
      </p>
      {single ? (
        <div className="grid grid-cols-2 gap-2">
          <Facts label="Existing" facts={first.existing} testId="conflict-existing" />
          <Facts label="New" facts={first.incoming} testId="conflict-incoming" />
        </div>
      ) : (
        <ul data-testid="conflict-names" className="rounded-md border border-white/[0.07] bg-black/30 px-3 py-2 font-mono text-[11px] text-zinc-300">
          {conflicts.slice(0, NAMES_SHOWN).map((item) => (
            <li key={item.name} className="truncate">
              {item.name}
              {item.existing.isDirectory ? '/' : ''}
            </li>
          ))}
          {conflictCount > NAMES_SHOWN && <li className="text-zinc-500">and {conflictCount - NAMES_SHOWN} more</li>}
        </ul>
      )}
      <ul className="list-disc space-y-1 pl-4">
        {replaceable && (
          <li>
            <span className="text-zinc-200">Replace</span> overwrites existing files.
            {folders && ' Folders are merged: files with the same name are replaced, and nothing else is deleted.'}
          </li>
        )}
        {conflicts.some((item) => !item.canReplace) && (
          <li>A file never replaces a folder, or the reverse; those are left out if you choose Replace.</li>
        )}
        <li>
          <span className="text-zinc-200">Keep both</span> adds a number to the new {single ? 'name' : 'names'}.
        </li>
        {canSkip && (
          <li>
            <span className="text-zinc-200">Skip</span> transfers only the items that don't exist yet.
          </li>
        )}
      </ul>
    </Dialog>
  )
}

function Facts({ label, facts, testId }: { label: string; facts: FileFacts; testId: string }): JSX.Element {
  return (
    <div data-testid={testId} className="rounded-md border border-white/[0.07] bg-black/30 px-3 py-2">
      <div className="text-[10px] tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-0.5 text-[12px] text-zinc-200">{facts.isDirectory ? 'Folder' : formatSize(facts.size)}</div>
      <div className="text-[11px] text-zinc-500">{formatModified(facts.modifiedAt)}</div>
    </div>
  )
}
