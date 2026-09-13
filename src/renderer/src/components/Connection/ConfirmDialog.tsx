import type { JSX } from 'react'
import { DANGER_BUTTON, Dialog, SECONDARY_BUTTON } from './Dialog'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** A destructive action, with Cancel focused so Enter never confirms by accident. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog
      title={title}
      tone="danger"
      onDismiss={onCancel}
      actions={
        <>
          <button type="button" data-autofocus onClick={onCancel} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className={DANGER_BUTTON}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Dialog>
  )
}
