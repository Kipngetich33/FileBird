/**
 * Keeps a fast shell from drowning the terminal (Milestone 11 plan D4).
 *
 * The terminal reports what it has drawn. While too much is waiting to be drawn
 * the source is paused — for SSH that stops the server sending, because ssh2
 * only extends the channel's window as the stream is read — and it starts again
 * once the terminal has caught up. The gap between the two marks stops a fast
 * command from flipping the source on and off thousands of times.
 *
 * The marks are the ones xterm.js's flow-control guide and VS Code use.
 */
export const HIGH_WATER_CHARS = 100_000
export const LOW_WATER_CHARS = 5_000

export class FlowControl {
  private unacked = 0
  private flowing = true

  constructor(
    private readonly highWater = HIGH_WATER_CHARS,
    private readonly lowWater = LOW_WATER_CHARS
  ) {}

  /** Counts output on its way to the terminal. True when the source should pause. */
  sent(chars: number): boolean {
    this.unacked += chars
    if (!this.flowing || this.unacked <= this.highWater) return false
    this.flowing = false
    return true
  }

  /** Counts output the terminal has drawn. True when the source should start again. */
  acknowledged(chars: number): boolean {
    this.unacked = Math.max(0, this.unacked - chars)
    if (this.flowing || this.unacked >= this.lowWater) return false
    this.flowing = true
    return true
  }

  get isFlowing(): boolean {
    return this.flowing
  }

  get waiting(): number {
    return this.unacked
  }
}
