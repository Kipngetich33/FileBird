import { describe, expect, it } from 'vitest'
import type { TransferJob } from '@shared/types/transfers'
import { describeSkipped, jobDetail, jobFraction, localPathOf, revealLabel, statusLabel, summarizeQueue } from './transfer-format'

let next = 0
const job = (overrides: Partial<TransferJob>): TransferJob => ({
  id: `job-${++next}`,
  batchId: 'batch-1',
  connectionId: 'connection',
  server: { host: 'h', port: 22, username: 'u' },
  direction: 'upload',
  name: 'report.pdf',
  relativePath: 'report.pdf',
  sourcePath: '/Users/me/report.pdf',
  destinationPath: '/srv/report.pdf',
  destinationDirectory: '/srv',
  batchDestination: '/srv',
  transferredBytes: 0,
  totalBytes: 48_000_000,
  bytesPerSecond: 0,
  status: 'queued',
  error: null,
  queuedAt: 0,
  startedAt: null,
  finishedAt: null,
  attempt: 1,
  ...overrides
})

describe('job formatting', () => {
  it('describes a running job with its amount and speed', () => {
    const running = job({ status: 'running', transferredBytes: 12_000_000, bytesPerSecond: 8_100_000 })
    expect(statusLabel(running)).toBe('Uploading')
    expect(jobDetail(running)).toBe('12 MB of 48 MB · 8.1 MB/s')
    expect(jobFraction(running)).toBe(0.25)
  })

  it('shows the reason for a failure, and full bars only when complete', () => {
    expect(jobDetail(job({ status: 'failed', error: { code: 'DISK_FULL', message: 'Out of space.' } }))).toBe('Out of space.')
    expect(jobFraction(job({ status: 'completed', totalBytes: 0 }))).toBe(1)
    expect(jobFraction(job({ status: 'running', totalBytes: null }))).toBe(0)
    expect(statusLabel(job({ status: 'running', direction: 'download' }))).toBe('Downloading')
  })
})

describe('summarizeQueue', () => {
  it('counts while work remains, adding up running speeds', () => {
    const summary = summarizeQueue([
      job({ status: 'running', bytesPerSecond: 20_000_000, transferredBytes: 24_000_000 }),
      job({ status: 'running', bytesPerSecond: 25_000_000 }),
      job({ status: 'queued' }),
      job({ status: 'completed' }),
      job({ status: 'failed' }),
      job({ status: 'completed', batchId: 'old-batch', totalBytes: 1_000_000_000 })
    ])
    expect(summary).toMatchObject({ running: 2, queued: 1, active: 3, failed: 1, completed: 2 })
    expect(summary.headline).toBe('2 running · 1 queued · 45 MB/s · 1 failed')
    // Only batches with work count: (24 MB + 48 MB) of 4 × 48 MB; the old batch is excluded.
    expect(summary.fraction).toBeCloseTo(72 / 192)
  })

  it('reports the outcome once idle', () => {
    expect(summarizeQueue([job({ status: 'completed' }), job({ status: 'cancelled' })]).headline).toBe('1 completed · 1 cancelled')
    expect(summarizeQueue([]).headline).toBe('No transfers')
  })
})

describe('describeSkipped', () => {
  it('groups skipped items by reason with a few examples', () => {
    expect(
      describeSkipped(
        [
          { path: 'site/link', reason: 'link-to-folder' },
          { path: 'a.txt', reason: 'exists' },
          { path: 'b.txt', reason: 'exists' }
        ],
        3
      )
    ).toBe('Skipped 3 items: links to folders (site/link); items that already exist (a.txt, b.txt).')
    expect(describeSkipped([], 0)).toBe('')
  })
})

describe('localPathOf', () => {
  it('points at what a download wrote, and at what an upload sent', () => {
    expect(localPathOf(job({ direction: 'download', sourcePath: '/srv/report.pdf', destinationPath: '/Users/me/Downloads/report.pdf' }))).toBe(
      '/Users/me/Downloads/report.pdf'
    )
    expect(localPathOf(job({ direction: 'upload', sourcePath: '/Users/me/report.pdf', destinationPath: '/srv/report.pdf' }))).toBe('/Users/me/report.pdf')
  })
})

describe('revealLabel', () => {
  it('calls the file manager what this computer calls it', () => {
    expect(revealLabel('darwin')).toBe('Show in Finder')
    expect(revealLabel('win32')).toBe('Show in File Explorer')
    expect(revealLabel('linux')).toBe('Show in the file manager')
  })
})
