/**
 * How one terminal tab is divided into panes (user request, 2026-10-19: split a
 * terminal side by side or one above the other, as macOS Terminal does).
 *
 * A tab holds a tree: a leaf is one shell, a split holds two children and the
 * share of the space the first one takes. Splitting replaces a leaf with a
 * split of itself and a new leaf; closing a pane replaces its split with the
 * sibling, so a tab with one pane left is a leaf again. Kept pure, because the
 * tree work is where the mistakes live.
 */

export type SplitDirection = 'row' | 'column'

export interface TerminalLeaf {
  kind: 'leaf'
  /** Stable for the pane's lifetime: React must not remount a live session. */
  key: string
  /** The folder this shell was started in. Each pane keeps its own. */
  cwd: string | null
}

export interface TerminalSplit {
  kind: 'split'
  id: string
  /** 'row' puts the panes side by side; 'column' stacks them. */
  direction: SplitDirection
  /** The first pane's share of the space, 0–1. */
  ratio: number
  first: TerminalNode
  second: TerminalNode
}

export type TerminalNode = TerminalLeaf | TerminalSplit

/** Neither pane may be squeezed below this share of its split. */
export const MIN_RATIO = 0.15
export const DEFAULT_RATIO = 0.5

export const leaf = (key: string, cwd: string | null): TerminalLeaf => ({ kind: 'leaf', key, cwd })

export const clampRatio = (ratio: number): number =>
  !Number.isFinite(ratio) ? DEFAULT_RATIO : Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio))

/** Every shell in the tree, left to right and top to bottom. */
export function paneKeys(node: TerminalNode): string[] {
  return node.kind === 'leaf' ? [node.key] : [...paneKeys(node.first), ...paneKeys(node.second)]
}

export const paneCount = (node: TerminalNode): number => paneKeys(node).length

export function firstPane(node: TerminalNode): TerminalLeaf {
  return node.kind === 'leaf' ? node : firstPane(node.first)
}

export function findPane(node: TerminalNode, key: string): TerminalLeaf | null {
  if (node.kind === 'leaf') return node.key === key ? node : null
  return findPane(node.first, key) ?? findPane(node.second, key)
}

/**
 * Divides `targetKey`'s pane in two, the new shell taking the second half.
 * Returns the tree unchanged when that pane isn't in it.
 */
export function splitPane(
  node: TerminalNode,
  targetKey: string,
  added: TerminalLeaf,
  direction: SplitDirection,
  splitId: string
): TerminalNode {
  if (node.kind === 'leaf') {
    if (node.key !== targetKey) return node
    return { kind: 'split', id: splitId, direction, ratio: DEFAULT_RATIO, first: node, second: added }
  }
  return {
    ...node,
    first: splitPane(node.first, targetKey, added, direction, splitId),
    second: splitPane(node.second, targetKey, added, direction, splitId)
  }
}

/** The tree without that pane, or null once the last one has gone. */
export function removePane(node: TerminalNode, key: string): TerminalNode | null {
  if (node.kind === 'leaf') return node.key === key ? null : node
  const first = removePane(node.first, key)
  const second = removePane(node.second, key)
  if (first === null) return second
  if (second === null) return first
  return { ...node, first, second }
}

/**
 * Moves one divider. Other splits keep their own share, and a tree that doesn't
 * hold that divider is returned as it was: a drag calls this on every pointer
 * move, and an unchanged tree must not look like a new one.
 */
export function resizeSplit(node: TerminalNode, splitId: string, ratio: number): TerminalNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) {
    const next = clampRatio(ratio)
    return next === node.ratio ? node : { ...node, ratio: next }
  }
  const first = resizeSplit(node.first, splitId, ratio)
  const second = resizeSplit(node.second, splitId, ratio)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/**
 * Which pane takes over when `key` closes: its neighbour inside the split it
 * belonged to — the pane the eye is already next to — else nothing.
 */
export function neighbourOf(node: TerminalNode, key: string): string | null {
  if (node.kind === 'leaf') return null
  const inFirst = findPane(node.first, key) !== null
  const inSecond = findPane(node.second, key) !== null
  if (inFirst && node.first.kind === 'leaf') return firstPane(node.second).key
  if (inSecond && node.second.kind === 'leaf') return firstPane(node.first).key
  return inFirst ? neighbourOf(node.first, key) : inSecond ? neighbourOf(node.second, key) : null
}

/** A box in percentages of the tab, which is how panes and dividers are placed. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface PaneBox extends Box {
  key: string
}

export interface DividerBox extends Box {
  id: string
  direction: SplitDirection
}

const WHOLE: Box = { left: 0, top: 0, width: 100, height: 100 }

/**
 * Where each shell and each divider sits, as percentages of the tab.
 *
 * The panes are laid out as one flat list rather than nested boxes, because
 * React remounts a component that changes its place in the tree — and
 * remounting a terminal ends its session. A flat, keyed list keeps every
 * terminal exactly where it was, whatever happens to the tree around it.
 */
export function layoutBoxes(node: TerminalNode, box: Box = WHOLE): { panes: PaneBox[]; dividers: DividerBox[] } {
  if (node.kind === 'leaf') return { panes: [{ key: node.key, ...box }], dividers: [] }

  const ratio = clampRatio(node.ratio)
  const along = node.direction === 'row' ? box.width : box.height
  const firstSize = along * ratio

  const first =
    node.direction === 'row'
      ? { ...box, width: firstSize }
      : { ...box, height: firstSize }
  const second =
    node.direction === 'row'
      ? { ...box, left: box.left + firstSize, width: along - firstSize }
      : { ...box, top: box.top + firstSize, height: along - firstSize }
  const divider: DividerBox =
    node.direction === 'row'
      ? { id: node.id, direction: node.direction, left: box.left + firstSize, top: box.top, width: 0, height: box.height }
      : { id: node.id, direction: node.direction, left: box.left, top: box.top + firstSize, width: box.width, height: 0 }

  const a = layoutBoxes(node.first, first)
  const b = layoutBoxes(node.second, second)
  return { panes: [...a.panes, ...b.panes], dividers: [divider, ...a.dividers, ...b.dividers] }
}
