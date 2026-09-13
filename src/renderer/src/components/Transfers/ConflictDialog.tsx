import type { JSX } from 'react'
import type { FileFacts } from '@shared/types/transfers'
import { DANGER_BUTTON, Dialog, PRIMARY_BUTTON, SECONDARY_BUTTON } from '@renderer/components/Connection/Dialog'
import type { TransferConflict } from '@renderer/hooks/useTransfers'
import { formatModified, formatSize } from '@renderer/utils/file-entries'

interface ConflictDialogProps {
  conflict: TransferConflict
  onReplace: () => void
  onKeepBoth: () => void
  onCancel: () => void
}

/**
 * The destination already has something by that name. Cancel is focused, so
 * Enter never replaces a file by accident; a folder is never replaceable.
 */
export function ConflictDialog({ conflict, onReplace, onKeepBoth, onCancel }: ConflictDialogProps): JSX.Element {
  const where = conflict.request.direction === 'upload' ? 'on the server' : 'on this computer'
  const what = conflict.existing.isDirectory ? 'A folder' : 'A file'

  return (
    <Dialog
      title={`"${conflict.name}" already exists`}
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" data-autofocus onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={onKeepBoth} className={conflict.canReplace ? SECONDARY_BUTTON : PRIMARY_BUTTON}>
            Keep both
          </button>
          {conflict.canReplace && (
            <button type="button" onClick={onReplace} className={DANGER_BUTTON}>
              Replace
            </button>
          )}
        </>
      }
    >
      <p>
        {what} with this name already exists in <span className="font-mono text-zinc-300">{conflict.request.destinationDirectory}</span>{' '}
        {where}.{' '}
        {conflict.canReplace
          ? 'Replace it, or keep both and save the new file with a number added to its name.'
          : 'A folder is never replaced by a file. You can keep both and save the file with a number added to its name.'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Facts label="Existing" facts={conflict.existing} testId="conflict-existing" />
        <Facts label="New" facts={conflict.incoming} testId="conflict-incoming" />
      </div>
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
