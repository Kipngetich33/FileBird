import { describe, expect, it } from 'vitest'
import type { TransferUpdate } from '@shared/types/transfers'
import { formatSpeed, transferDetail, transferFraction, transferHeadline } from './transfer-format'

const base: TransferUpdate = {
  id: 'id',
  connectionId: 'connection',
  direction: 'upload',
  name: 'report.pdf',
  sourcePath: '/Users/me/report.pdf',
  destinationPath: '/srv/report.pdf',
  destinationDirectory: '/srv',
  transferredBytes: 12_000_000,
  totalBytes: 48_000_000,
  bytesPerSecond: 8_100_000,
  status: 'running',
  error: null,
  startedAt: 0,
  finishedAt: null
}

describe('transfer formatting', () => {
  it('describes a running transfer with its speed', () => {
    expect(transferHeadline(base)).toBe('Uploading report.pdf')
    expect(transferDetail(base)).toBe('12 MB of 48 MB · 8.1 MB/s')
    expect(transferFraction(base)).toBe(0.25)
  })

  it('leaves the speed out until there is one', () => {
    expect(transferDetail({ ...base, bytesPerSecond: 0, transferredBytes: 0 })).toBe('0 bytes of 48 MB')
    expect(formatSpeed(0)).toBe('')
  })

  it('treats an empty file as complete once done, and never exceeds the bar', () => {
    expect(transferFraction({ transferredBytes: 0, totalBytes: 0, status: 'running' })).toBe(0)
    expect(transferFraction({ transferredBytes: 0, totalBytes: 0, status: 'completed' })).toBe(1)
    expect(transferFraction({ transferredBytes: 60, totalBytes: 50, status: 'running' })).toBe(1)
  })

  it('describes the final states', () => {
    expect(transferHeadline({ ...base, direction: 'download', status: 'completed' })).toBe('Downloaded report.pdf')
    expect(transferHeadline({ ...base, status: 'cancelled' })).toBe('Upload of report.pdf cancelled')
    const failed = { ...base, status: 'failed' as const, error: { code: 'DISK_FULL' as const, message: 'Out of space.' } }
    expect(transferHeadline(failed)).toBe('Upload of report.pdf failed')
    expect(transferDetail(failed)).toBe('Out of space.')
  })
})
