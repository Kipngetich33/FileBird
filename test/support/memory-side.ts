import { posix } from 'node:path'
import type { FileKind } from '../../src/shared/types/files'
import { AppError } from '../../src/main/errors'
import type { FileSide, FileStat, SideEntry } from '../../src/main/transfers/sides'

export interface MemoryNode {
  kind: FileKind
  size?: number
  isSymlink?: boolean
  /** Listing this folder is refused. */
  unreadable?: boolean
}

/**
 * An in-memory file side for planner and queue tests: POSIX paths, one flat
 * map of path to node. Records every folder it creates.
 */
export class MemorySide implements FileSide {
  readonly remote: boolean
  readonly nodes = new Map<string, MemoryNode>()
  readonly created: string[] = []

  constructor(remote: boolean, nodes: Record<string, MemoryNode | 'dir' | number> = {}) {
    this.remote = remote
    this.nodes.set('/', { kind: 'directory' })
    for (const [path, node] of Object.entries(nodes)) this.add(path, node)
  }

  add(path: string, node: MemoryNode | 'dir' | number): void {
    const value: MemoryNode = node === 'dir' ? { kind: 'directory' } : typeof node === 'number' ? { kind: 'file', size: node } : node
    // Parents exist implicitly.
    for (let parent = posix.dirname(path); !this.nodes.has(parent); parent = posix.dirname(parent)) {
      this.nodes.set(parent, { kind: 'directory' })
    }
    this.nodes.set(path, value)
  }

  join = posix.join
  basename = posix.basename

  async stat(path: string): Promise<FileStat | null> {
    const node = this.nodes.get(path)
    if (node === undefined) return null
    return { kind: node.kind, size: node.size ?? 0, modifiedAt: 1_000, mode: 0o644 }
  }

  async list(path: string): Promise<SideEntry[]> {
    const node = this.nodes.get(path)
    if (node === undefined) throw new AppError('NOT_FOUND', 'missing')
    if (node.unreadable) throw new AppError('PERMISSION_DENIED', 'unreadable')
    return [...this.nodes.entries()]
      .filter(([child]) => child !== '/' && posix.dirname(child) === path)
      .map(([child, value]) => ({
        name: posix.basename(child),
        path: child,
        kind: value.kind,
        isSymlink: value.isSymlink ?? false,
        size: value.kind === 'file' ? (value.size ?? 0) : null,
        modifiedAt: 1_000
      }))
  }

  async mkdir(path: string): Promise<'created' | 'exists'> {
    const node = this.nodes.get(path)
    if (node?.kind === 'directory') return 'exists'
    if (node !== undefined) throw new AppError('ALREADY_EXISTS', 'exists')
    this.nodes.set(path, { kind: 'directory' })
    this.created.push(path)
    return 'created'
  }
}
