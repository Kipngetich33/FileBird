import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATIO,
  MIN_RATIO,
  clampRatio,
  findPane,
  firstPane,
  layoutBoxes,
  leaf,
  neighbourOf,
  paneCount,
  paneKeys,
  removePane,
  resizeSplit,
  splitPane,
  type TerminalNode
} from './terminal-layout'

const tree = (): TerminalNode => {
  // a | (b / c): one pane on the left, two stacked on the right.
  const right = splitPane(leaf('b', null), 'b', leaf('c', null), 'column', 's2')
  return { kind: 'split', id: 's1', direction: 'row', ratio: DEFAULT_RATIO, first: leaf('a', null), second: right }
}

describe('splitting a pane', () => {
  it('turns one pane into two, the new shell taking the second half', () => {
    const split = splitPane(leaf('a', '/home'), 'a', leaf('b', '/var'), 'row', 's1')
    expect(split).toEqual({
      kind: 'split',
      id: 's1',
      direction: 'row',
      ratio: DEFAULT_RATIO,
      first: leaf('a', '/home'),
      second: leaf('b', '/var')
    })
  })

  it('keeps each pane the folder it was started in', () => {
    const split = splitPane(leaf('a', '/home'), 'a', leaf('b', '/var/log'), 'column', 's1')
    expect(findPane(split, 'a')?.cwd).toBe('/home')
    expect(findPane(split, 'b')?.cwd).toBe('/var/log')
  })

  it('splits a pane nested deep in the tree, and leaves the others alone', () => {
    const grown = splitPane(tree(), 'c', leaf('d', null), 'row', 's3')
    expect(paneKeys(grown)).toEqual(['a', 'b', 'c', 'd'])
    expect(findPane(grown, 'a')).not.toBeNull()
  })

  it('changes nothing when that pane is not in the tree', () => {
    const before = tree()
    expect(splitPane(before, 'gone', leaf('x', null), 'row', 's9')).toEqual(before)
  })

  it('splits both ways', () => {
    expect(splitPane(leaf('a', null), 'a', leaf('b', null), 'row', 's1')).toMatchObject({ direction: 'row' })
    expect(splitPane(leaf('a', null), 'a', leaf('b', null), 'column', 's1')).toMatchObject({ direction: 'column' })
  })
})

describe('closing a pane', () => {
  it('leaves the sibling where the split was, with no split left behind', () => {
    const closed = removePane(splitPane(leaf('a', null), 'a', leaf('b', null), 'row', 's1'), 'a')
    expect(closed).toEqual(leaf('b', null))
  })

  it('collapses only the split the pane belonged to', () => {
    const closed = removePane(tree(), 'c')
    expect(paneKeys(closed as TerminalNode)).toEqual(['a', 'b'])
    expect(closed).toMatchObject({ kind: 'split', id: 's1' })
  })

  it('reports nothing left once the last pane closes', () => {
    expect(removePane(leaf('a', null), 'a')).toBeNull()
  })

  it('never leaves a split with one child, however many close', () => {
    let node: TerminalNode | null = tree()
    for (const key of ['b', 'a', 'c']) {
      node = removePane(node as TerminalNode, key)
      if (node === null) break
      const walk = (candidate: TerminalNode): void => {
        if (candidate.kind === 'leaf') return
        expect(candidate.first).toBeDefined()
        expect(candidate.second).toBeDefined()
        walk(candidate.first)
        walk(candidate.second)
      }
      walk(node)
    }
    expect(node).toBeNull()
  })
})

describe('which pane takes over', () => {
  it('hands over to the pane beside it', () => {
    const side = splitPane(leaf('a', null), 'a', leaf('b', null), 'row', 's1')
    expect(neighbourOf(side, 'a')).toBe('b')
    expect(neighbourOf(side, 'b')).toBe('a')
  })

  it('stays inside the split the pane belonged to', () => {
    expect(neighbourOf(tree(), 'b')).toBe('c')
    expect(neighbourOf(tree(), 'c')).toBe('b')
    expect(neighbourOf(tree(), 'a')).toBe('b')
  })

  it('has nobody to hand over to in a tab with one pane', () => {
    expect(neighbourOf(leaf('a', null), 'a')).toBeNull()
  })
})

describe('the divider', () => {
  it('moves one split and leaves the rest where they are', () => {
    const moved = resizeSplit(tree(), 's2', 0.7)
    expect((moved as { second: { ratio: number } }).second.ratio).toBe(0.7)
    expect((moved as { ratio: number }).ratio).toBe(DEFAULT_RATIO)
  })

  it('returns the very same tree when the drag changes nothing, so panes do not re-render', () => {
    const before = tree()
    expect(resizeSplit(before, 's2', 0.7)).not.toBe(before)
    expect(resizeSplit(before, 'no-such-split', 0.7)).toBe(before)
    const moved = resizeSplit(before, 's1', 0.3)
    expect(resizeSplit(moved, 's1', 0.3)).toBe(moved)
    // The half that didn't move keeps the object it had.
    expect((resizeSplit(before, 's1', 0.3) as { second: unknown }).second).toBe((before as { second: unknown }).second)
  })

  it('never squeezes a pane out of existence', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(1 - MIN_RATIO)
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO)
    expect(clampRatio(0.42)).toBe(0.42)
  })
})

describe('reading the tree', () => {
  it('counts and lists every shell, in reading order', () => {
    expect(paneKeys(tree())).toEqual(['a', 'b', 'c'])
    expect(paneCount(tree())).toBe(3)
    expect(firstPane(tree()).key).toBe('a')
  })
})

describe('where the panes and dividers sit', () => {
  it('gives one pane the whole tab', () => {
    const { panes, dividers } = layoutBoxes(leaf('a', null))
    expect(panes).toEqual([{ key: 'a', left: 0, top: 0, width: 100, height: 100 }])
    expect(dividers).toEqual([])
  })

  it('divides left and right, with the divider on the boundary', () => {
    const { panes, dividers } = layoutBoxes(splitPane(leaf('a', null), 'a', leaf('b', null), 'row', 's1'))
    expect(panes).toEqual([
      { key: 'a', left: 0, top: 0, width: 50, height: 100 },
      { key: 'b', left: 50, top: 0, width: 50, height: 100 }
    ])
    expect(dividers).toEqual([{ id: 's1', direction: 'row', left: 50, top: 0, width: 0, height: 100 }])
  })

  it('divides top and bottom', () => {
    const { panes } = layoutBoxes(splitPane(leaf('a', null), 'a', leaf('b', null), 'column', 's1'))
    expect(panes).toEqual([
      { key: 'a', left: 0, top: 0, width: 100, height: 50 },
      { key: 'b', left: 0, top: 50, width: 100, height: 50 }
    ])
  })

  it('follows the divider when it has been dragged', () => {
    const moved = resizeSplit(splitPane(leaf('a', null), 'a', leaf('b', null), 'row', 's1'), 's1', 0.25)
    const { panes } = layoutBoxes(moved)
    expect(panes[0]).toMatchObject({ key: 'a', width: 25 })
    expect(panes[1]).toMatchObject({ key: 'b', left: 25, width: 75 })
  })

  it('nests, and the boxes always fill the tab exactly once', () => {
    const { panes, dividers } = layoutBoxes(tree())
    expect(panes.map((pane) => pane.key)).toEqual(['a', 'b', 'c'])
    expect(dividers.map((divider) => divider.id).sort()).toEqual(['s1', 's2'])
    const area = panes.reduce((sum, pane) => sum + (pane.width * pane.height) / 100, 0)
    expect(area).toBeCloseTo(100)
    expect(panes.every((pane) => pane.left >= 0 && pane.top >= 0 && pane.width > 0 && pane.height > 0)).toBe(true)
  })
})
