import type { TransferUpdate } from '@shared/types/transfers'
import { formatSize } from './file-entries'

/** 0 to 1. An empty file is complete as soon as it starts. */
export function transferFraction(update: Pick<TransferUpdate, 'transferredBytes' | 'totalBytes' | 'status'>): number {
  if (update.status === 'completed') return 1
  if (update.totalBytes <= 0) return 0
  return Math.min(1, Math.max(0, update.transferredBytes / update.totalBytes))
}

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond <= 0 ? '' : `${formatSize(Math.round(bytesPerSecond))}/s`
}

/** "12 MB of 48 MB · 8.1 MB/s" while running; the final size once done. */
export function transferDetail(update: TransferUpdate): string {
  switch (update.status) {
    case 'running': {
      const speed = formatSpeed(update.bytesPerSecond)
      const amount = `${formatSize(update.transferredBytes)} of ${formatSize(update.totalBytes)}`
      return speed === '' ? amount : `${amount} · ${speed}`
    }
    case 'completed':
      return formatSize(update.totalBytes)
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return update.error?.message ?? 'The transfer failed.'
  }
}

export function transferHeadline(update: TransferUpdate): string {
  const verb = update.direction === 'upload' ? 'Upload' : 'Download'
  switch (update.status) {
    case 'running':
      return `${update.direction === 'upload' ? 'Uploading' : 'Downloading'} ${update.name}`
    case 'completed':
      return `${update.direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${update.name}`
    case 'cancelled':
      return `${verb} of ${update.name} cancelled`
    case 'failed':
      return `${verb} of ${update.name} failed`
  }
}
