import type { JSX } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { TransferUpdate } from '@shared/types/transfers'
import { transferDetail, transferFraction, transferHeadline } from '@renderer/utils/transfer-format'

interface TransferBarProps {
  transfer: TransferUpdate | null
  refusal: AppErrorPayload | null
  onCancel: () => void
  onDismiss: () => void
  onDismissRefusal: () => void
}

const TONE = {
  running: 'text-zinc-200',
  completed: 'text-emerald-300',
  cancelled: 'text-zinc-400',
  failed: 'text-red-300'
} as const

/**
 * The current transfer, above the status bar, with any refused request on its
 * own row, so a refusal never hides a transfer that is still running.
 */
export function TransferBar({ transfer, refusal, onCancel, onDismiss, onDismissRefusal }: TransferBarProps): JSX.Element | null {
  if (refusal === null && transfer === null) return null
  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-[#0e1117]">
      {refusal !== null && (
        <div role="alert" data-testid="transfer-refusal" className={`${ROW} h-8`}>
          <span className="min-w-0 flex-1 truncate text-red-300 select-text">{refusal.message}</span>
          <BarButton label="Dismiss" onClick={onDismissRefusal} />
        </div>
      )}
      {transfer !== null && <TransferRow transfer={transfer} onCancel={onCancel} onDismiss={onDismiss} />}
    </div>
  )
}

function TransferRow({ transfer, onCancel, onDismiss }: { transfer: TransferUpdate; onCancel: () => void; onDismiss: () => void }): JSX.Element {

  const running = transfer.status === 'running'
  const percent = Math.round(transferFraction(transfer) * 100)
  const destination = `to ${transfer.destinationDirectory}`

  return (
    <div
      role={transfer.status === 'failed' ? 'alert' : 'status'}
      data-testid="transfer-bar"
      data-status={transfer.status}
      data-transfer-id={transfer.id}
      className={`${ROW} h-11`}
    >
      <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 fill-none stroke-current stroke-[1.6] ${TONE[transfer.status]}`} aria-hidden>
        {transfer.direction === 'upload' ? <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" /> : <path d="M8 3v9.5M3.5 8 8 12.5 12.5 8" />}
      </svg>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span data-testid="transfer-headline" className={`min-w-0 truncate font-medium ${TONE[transfer.status]}`} title={transfer.name}>
            {transferHeadline(transfer)}
          </span>
          <span className="hidden min-w-0 truncate font-mono text-[10px] text-zinc-500 sm:inline" title={transfer.destinationPath}>
            {destination}
          </span>
        </div>
        {running && (
          <div
            role="progressbar"
            aria-label={`${transfer.name} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1 overflow-hidden rounded-full bg-white/[0.08]"
          >
            <div className="h-full rounded-full bg-sky-500 transition-[width] duration-150" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      <span data-testid="transfer-detail" className={`max-w-[45%] shrink-0 truncate tabular-nums select-text ${transfer.status === 'failed' ? 'text-red-300' : 'text-zinc-400'}`}>
        {transferDetail(transfer)}
      </span>

      {running ? <BarButton label="Cancel" onClick={onCancel} /> : <BarButton label="Dismiss" onClick={onDismiss} />}
    </div>
  )
}

const ROW = 'flex items-center gap-3 px-4 text-[12px] [&+&]:border-t [&+&]:border-white/[0.06]'

function BarButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-100"
    >
      {label}
    </button>
  )
}
