import { memo, useMemo, useState, type JSX } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import type { TransferJob } from '@shared/types/transfers'
import { jobDetail, jobFraction, localPathOf, revealLabel, statusLabel, type QueueSummary } from '@renderer/utils/transfer-format'

type Filter = 'all' | 'active' | 'completed' | 'failed'

/** Rows rendered per filter; a 10,000-file request would otherwise stall the window. */
const ROW_LIMIT = 500

interface TransferPanelProps {
  jobs: TransferJob[]
  summary: QueueSummary
  expanded: boolean
  onToggle: () => void
  preparing: boolean
  notice: string | null
  refusal: AppErrorPayload | null
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  /** Shows a finished transfer's file on this computer. */
  onReveal: (path: string) => void
  /** This computer's platform, so the button says Finder, File Explorer or file manager. */
  platform: string
  onCancelAll: () => void
  onRetryFailed: () => void
  onClearFinished: () => void
  onDismissNotice: () => void
  onDismissRefusal: () => void
}

const matches: Record<Filter, (job: TransferJob) => boolean> = {
  all: () => true,
  active: (job) => job.status === 'queued' || job.status === 'running',
  completed: (job) => job.status === 'completed',
  // Cancelled jobs can be retried too, so they are listed with the failures.
  failed: (job) => job.status === 'failed' || job.status === 'cancelled'
}

/**
 * The transfer queue (spec section 13), above the status bar: a summary line
 * with overall progress, and a list of every job that can be filtered.
 * Refusals and notices get their own rows, so they never hide the queue.
 */
export function TransferPanel(props: TransferPanelProps): JSX.Element | null {
  const { jobs, summary, expanded, preparing, notice, refusal } = props
  const [filter, setFilter] = useState<Filter>('all')

  const counts = useMemo(
    () => ({
      all: jobs.length,
      active: summary.active,
      completed: summary.completed,
      failed: summary.failed + summary.cancelled
    }),
    [jobs.length, summary]
  )
  const visible = useMemo(() => inViewOrder(jobs.filter(matches[filter])), [jobs, filter])

  if (jobs.length === 0 && !preparing && notice === null && refusal === null) return null

  return (
    <section aria-label="Transfers" data-testid="transfer-panel" className="shrink-0 border-t border-white/[0.06] bg-[#0e1117] text-[12px]">
      {refusal !== null && (
        <MessageRow testId="transfer-refusal" tone="error" message={refusal.message} onDismiss={props.onDismissRefusal} />
      )}
      {notice !== null && <MessageRow testId="transfer-notice" tone="notice" message={notice} onDismiss={props.onDismissNotice} />}

      {(jobs.length > 0 || preparing) && (
        <div className="flex h-10 items-center gap-3 px-4">
          <button
            type="button"
            onClick={props.onToggle}
            aria-expanded={expanded}
            aria-controls="transfer-list"
            className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase transition hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" className={`h-3 w-3 fill-none stroke-current stroke-[1.8] transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden>
              <path d="M4 6l4 4 4-4" />
            </svg>
            Transfers
          </button>
          <span data-testid="transfer-summary" className="min-w-0 truncate text-zinc-300 tabular-nums">
            {preparing ? 'Preparing…' : summary.headline}
          </span>
          {summary.active > 0 && (
            <div
              role="progressbar"
              aria-label="Overall progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(summary.fraction * 100)}
              className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-white/[0.08]"
            >
              <div className="h-full rounded-full bg-sky-500 transition-[width] duration-150" style={{ width: `${summary.fraction * 100}%` }} />
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {summary.active > 0 && <PanelButton label="Cancel all" onClick={props.onCancelAll} />}
            {summary.failed > 0 && <PanelButton label="Retry failed" onClick={props.onRetryFailed} />}
            {summary.completed + summary.failed + summary.cancelled > 0 && <PanelButton label="Clear finished" onClick={props.onClearFinished} />}
          </div>
        </div>
      )}

      {expanded && jobs.length > 0 && (
        <div id="transfer-list" className="border-t border-white/[0.06]">
          <div role="group" aria-label="Show" className="flex gap-1 px-4 pt-1.5 pb-1">
            {(['all', 'active', 'completed', 'failed'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                data-filter={option}
                onClick={() => setFilter(option)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                  filter === option ? 'bg-sky-500/20 text-sky-200' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
                }`}
              >
                {option === 'all' ? 'All' : option === 'active' ? 'Active' : option === 'completed' ? 'Completed' : 'Failed'}{' '}
                <span className="tabular-nums opacity-70">{counts[option]}</span>
              </button>
            ))}
          </div>
          <ul aria-label="Transfer jobs" className="max-h-[24vh] overflow-y-auto pb-1">
            {visible.slice(0, ROW_LIMIT).map((job) => (
              <JobRow key={job.id} job={job} onCancel={props.onCancel} onRetry={props.onRetry} onReveal={props.onReveal} platform={props.platform} />
            ))}
            {visible.length === 0 && <li className="px-4 py-3 text-zinc-500">Nothing here.</li>}
            {visible.length > ROW_LIMIT && (
              <li className="px-4 py-2 text-zinc-500">{(visible.length - ROW_LIMIT).toLocaleString()} more not shown.</li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * What needs attention first: running, then queued in the order they will
 * run, then finished jobs with the most recent first.
 */
function inViewOrder(jobs: TransferJob[]): TransferJob[] {
  const running = jobs.filter((job) => job.status === 'running')
  const queued = jobs.filter((job) => job.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt)
  const finished = jobs
    .filter((job) => job.status !== 'running' && job.status !== 'queued')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  return [...running, ...queued, ...finished]
}

const TONE = {
  queued: 'text-zinc-400',
  running: 'text-sky-300',
  completed: 'text-emerald-300',
  failed: 'text-red-300',
  cancelled: 'text-zinc-500'
} as const

const JobRow = memo(function JobRow({
  job,
  onCancel,
  onRetry,
  onReveal,
  platform
}: {
  job: TransferJob
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onReveal: (path: string) => void
  platform: string
}): JSX.Element {
  const folder = job.relativePath.includes('/') ? job.relativePath.slice(0, job.relativePath.lastIndexOf('/')) : ''
  const active = job.status === 'queued' || job.status === 'running'
  const percent = Math.round(jobFraction(job) * 100)

  return (
    <li data-job-id={job.id} data-status={job.status} data-name={job.relativePath} className="flex h-8 items-center gap-3 px-4 hover:bg-white/[0.02]">
      <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 fill-none stroke-current stroke-[1.6] ${TONE[job.status]}`} aria-label={job.direction === 'upload' ? 'Upload' : 'Download'}>
        {job.direction === 'upload' ? <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" /> : <path d="M8 3v9.5M3.5 8 8 12.5 12.5 8" />}
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-zinc-200" title={job.destinationPath}>
            {job.name}
          </span>
          {folder !== '' && <span className="hidden min-w-0 truncate text-[11px] text-zinc-500 sm:inline">{folder}</span>}
        </div>
        {job.status === 'running' && (
          <div
            role="progressbar"
            aria-label={`${job.name} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1 overflow-hidden rounded-full bg-white/[0.08]"
          >
            <div className="h-full rounded-full bg-sky-500 transition-[width] duration-150" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <span data-testid="job-status" className={`w-20 shrink-0 text-[11px] ${TONE[job.status]}`}>
        {statusLabel(job)}
      </span>
      <span
        data-testid="job-detail"
        title={jobDetail(job)}
        className={`w-44 shrink-0 truncate text-right text-[11px] tabular-nums ${job.status === 'failed' ? 'text-red-300' : 'text-zinc-500'}`}
      >
        {jobDetail(job)}
      </span>
      <div className="w-14 shrink-0 text-right">
        {active ? (
          <PanelButton label="Cancel" onClick={() => onCancel(job.id)} />
        ) : job.status === 'failed' || job.status === 'cancelled' ? (
          <PanelButton label="Retry" onClick={() => onRetry(job.id)} />
        ) : job.status === 'completed' ? (
          // Where it went, the way a browser's downloads list shows you.
          <PanelButton label="Show" title={`${revealLabel(platform)}: ${localPathOf(job)}`} onClick={() => onReveal(localPathOf(job))} />
        ) : null}
      </div>
    </li>
  )
})

function MessageRow({ testId, tone, message, onDismiss }: { testId: string; tone: 'error' | 'notice'; message: string; onDismiss: () => void }): JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={`flex min-h-8 items-center gap-3 border-b border-white/[0.06] px-4 py-1.5 ${tone === 'error' ? 'text-red-300' : 'text-amber-200'}`}
    >
      <span className="min-w-0 flex-1 select-text">{message}</span>
      <PanelButton label="Dismiss" onClick={onDismiss} />
    </div>
  )
}

function PanelButton({ label, title, onClick }: { label: string; title?: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      {...(title === undefined ? {} : { title })}
      data-testid={`panel-${label.toLowerCase()}`}
      onClick={onClick}
      className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-100"
    >
      {label}
    </button>
  )
}
