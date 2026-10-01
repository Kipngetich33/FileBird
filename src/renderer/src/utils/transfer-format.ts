import type { SkipReason, SkippedItem, TransferJob } from '@shared/types/transfers'
import { formatSize } from './file-entries'

/** 0 to 1. A completed job is full even when its size was unknown or zero. */
export function jobFraction(job: Pick<TransferJob, 'transferredBytes' | 'totalBytes' | 'status'>): number {
  if (job.status === 'completed') return 1
  if (job.totalBytes === null || job.totalBytes <= 0) return 0
  return Math.min(1, Math.max(0, job.transferredBytes / job.totalBytes))
}

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond <= 0 ? '' : `${formatSize(Math.round(bytesPerSecond))}/s`
}

/**
 * The job's file on this computer: what a download wrote, or what an upload
 * sent. This is what "Show" opens the file manager at.
 */
export function localPathOf(job: TransferJob): string {
  return job.direction === 'download' ? job.destinationPath : job.sourcePath
}

/** What the file manager is called here, as the button says it. */
export function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Show in Finder'
  if (platform === 'win32') return 'Show in File Explorer'
  return 'Show in the file manager'
}

export function statusLabel(job: Pick<TransferJob, 'status' | 'direction'>): string {
  switch (job.status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return job.direction === 'upload' ? 'Uploading' : 'Downloading'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** "12 MB of 48 MB · 8.1 MB/s" while running; the reason when failed. */
export function jobDetail(job: TransferJob): string {
  switch (job.status) {
    case 'running': {
      const amount = `${formatSize(job.transferredBytes)} of ${formatSize(job.totalBytes)}`
      const speed = formatSpeed(job.bytesPerSecond)
      return speed === '' ? amount : `${amount} · ${speed}`
    }
    case 'failed':
      return job.error?.message ?? 'The transfer failed.'
    case 'queued':
    case 'completed':
    case 'cancelled':
      return formatSize(job.totalBytes)
  }
}

export interface QueueSummary {
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
  /** Queued or running. */
  active: number
  bytesPerSecond: number
  /** Progress across the batches that still have work, 0 to 1. */
  fraction: number
  headline: string
}

export function summarizeQueue(jobs: readonly TransferJob[]): QueueSummary {
  const count = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  let bytesPerSecond = 0
  const activeBatches = new Set<string>()
  for (const job of jobs) {
    count[job.status] += 1
    if (job.status === 'running') bytesPerSecond += job.bytesPerSecond
    if (job.status === 'queued' || job.status === 'running') activeBatches.add(job.batchId)
  }

  let total = 0
  let done = 0
  for (const job of jobs) {
    if (!activeBatches.has(job.batchId) || job.status === 'failed' || job.status === 'cancelled') continue
    total += job.totalBytes ?? 0
    done += job.status === 'completed' ? (job.totalBytes ?? 0) : job.transferredBytes
  }

  const active = count.queued + count.running
  const parts =
    active > 0
      ? [`${count.running} running`, count.queued > 0 ? `${count.queued} queued` : '', formatSpeed(bytesPerSecond), count.failed > 0 ? `${count.failed} failed` : '']
      : [
          count.completed > 0 ? `${count.completed} completed` : '',
          count.failed > 0 ? `${count.failed} failed` : '',
          count.cancelled > 0 ? `${count.cancelled} cancelled` : ''
        ]

  return {
    ...count,
    active,
    bytesPerSecond,
    fraction: total > 0 ? Math.min(1, done / total) : active > 0 ? 0 : 1,
    headline: parts.filter(Boolean).join(' · ') || 'No transfers'
  }
}

const SKIP_REASONS: Record<SkipReason, string> = {
  'link-to-folder': 'links to folders',
  special: 'broken links or special files',
  unreadable: "folders you don't have permission to read",
  'kind-mismatch': 'items whose name is taken by a different kind of item (a file never replaces a folder)',
  exists: 'items that already exist',
  'invalid-name': "names this computer can't store"
}

/** "Skipped 3 items: links to folders (link), items that already exist (a.txt, b.txt)." */
export function describeSkipped(skipped: readonly SkippedItem[], total: number): string {
  if (total === 0) return ''
  const groups = new Map<SkipReason, string[]>()
  for (const item of skipped) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item.path])
  const details = [...groups.entries()].map(([reason, paths]) => {
    const shown = paths.slice(0, 3).join(', ')
    return `${SKIP_REASONS[reason]} (${paths.length > 3 ? `${shown}, …` : shown})`
  })
  return `Skipped ${total === 1 ? '1 item' : `${total} items`}: ${details.join('; ')}.`
}
