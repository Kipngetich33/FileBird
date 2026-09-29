import { describe, expect, it } from 'vitest'
import { FlowControl, HIGH_WATER_CHARS, LOW_WATER_CHARS } from './flow-control'

describe('FlowControl', () => {
  it('lets output flow until too much is waiting to be drawn', () => {
    const flow = new FlowControl()
    expect(flow.sent(HIGH_WATER_CHARS)).toBe(false)
    expect(flow.isFlowing).toBe(true)
    expect(flow.sent(1)).toBe(true)
    expect(flow.isFlowing).toBe(false)
  })

  it('asks to pause once only, however much more arrives', () => {
    const flow = new FlowControl()
    flow.sent(HIGH_WATER_CHARS + 1)
    expect(flow.sent(50_000)).toBe(false)
  })

  it('starts the flow again only once the terminal has nearly caught up', () => {
    const flow = new FlowControl()
    flow.sent(HIGH_WATER_CHARS + 1)
    expect(flow.acknowledged(HIGH_WATER_CHARS - LOW_WATER_CHARS)).toBe(false)
    expect(flow.waiting).toBe(LOW_WATER_CHARS + 1)
    expect(flow.acknowledged(2)).toBe(true)
    expect(flow.isFlowing).toBe(true)
  })

  it('says nothing about a flow that was never paused', () => {
    const flow = new FlowControl()
    flow.sent(10)
    expect(flow.acknowledged(10)).toBe(false)
  })

  it('never counts below nothing waiting, whatever the terminal reports', () => {
    const flow = new FlowControl()
    flow.sent(100)
    flow.acknowledged(1_000)
    expect(flow.waiting).toBe(0)
  })
})
