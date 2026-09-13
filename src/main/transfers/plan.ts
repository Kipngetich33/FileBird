import type { FileKind } from '../../shared/types/files'
import type { ConflictResolution, FileFacts, SkippedItem, TransferConflict } from '../../shared/types/transfers'
import { AppError } from '../errors'
import { mapLimit } from '../utils/map-limit'
import { assertTransferName, firstFreeName } from './names'
import type { FileSide, FileStat } from './sides'

export interface TransferLimits {
  maxFiles: number
  maxDepth: number
}

export const DEFAULT_LIMITS: TransferLimits = { maxFiles: 10_000, maxDepth: 64 }

/** Parallel stats while planning; a remote stat is a round trip each. */
const PLAN_CONCURRENCY = 8

export interface PlannedFile {
  sourcePath: string
  destinationPath: string
  destinationDirectory: string
  name: string
  /** Inside the request, "/"-separated: "photos/2024/a.jpg". */
  relativePath: string
  size: number | null
  /** Replace was chosen and a file of this name is already there. */
  replace: boolean
}

export type TransferPlan =
  | { status: 'conflict'; conflicts: TransferConflict[] }
  | { status: 'ready'; files: PlannedFile[]; folders: string[]; skipped: SkippedItem[] }

export interface PlanOptions {
  source: FileSide
  destination: FileSide
  sourcePaths: string[]
  destinationDirectory: string
  onConflict: ConflictResolution
  /** Whose naming rules apply to created names. */
  destinationPlatform: NodeJS.Platform
  limits?: TransferLimits
}

interface Root {
  path: string
  name: string
  info: FileStat
  existing: FileStat | null
}

const facts = (file: FileStat): FileFacts => ({
  size: file.kind === 'file' ? file.size : null,
  modifiedAt: file.modifiedAt,
  isDirectory: file.kind === 'directory'
})

function validName(name: string, platform: NodeJS.Platform): boolean {
  try {
    assertTransferName(name, platform)
    return true
  } catch {
    return false
  }
}

/**
 * Turns a request into the files to queue and the folders to create
 * (Milestone 7 plan D1–D3). Nothing is written unless the plan is ready: with
 * `ask`, existing names come back as conflicts first.
 *
 * - Replace merges folders (files with the same name are replaced, nothing is
 *   deleted) and never swaps a file for a folder or the reverse.
 * - Keep both numbers conflicting top-level items, reserving names within the
 *   request so two items never pick the same one.
 * - Inside folders, links to folders aren't followed (no cycles), and broken
 *   links, special files, unreadable folders and names the destination can't
 *   store are skipped and reported.
 */
export async function planTransfer(options: PlanOptions): Promise<TransferPlan> {
  const { source, destination, destinationDirectory, destinationPlatform } = options
  const limits = options.limits ?? DEFAULT_LIMITS

  const named = options.sourcePaths.map((path) => ({ path, name: source.basename(path) }))
  const seen = new Set<string>()
  for (const { name } of named) {
    assertTransferName(name, destinationPlatform)
    if (seen.has(name)) throw new AppError('INVALID_INPUT', `More than one selected item is named "${name}".`)
    seen.add(name)
  }

  const folder = await destination.stat(destinationDirectory)
  if (folder === null) throw new AppError('NOT_FOUND', 'The destination folder no longer exists.')
  if (folder.kind !== 'directory') throw new AppError('NOT_A_DIRECTORY', 'The destination is not a folder.')

  const skipped: SkippedItem[] = []
  const described = await mapLimit(named, PLAN_CONCURRENCY, async ({ path, name }) => {
    const info = await source.stat(path)
    if (info === null) throw new AppError('NOT_FOUND', `"${name}" no longer exists.`)
    if (info.kind === 'other') return null
    const existing = await destination.stat(destination.join(destinationDirectory, name))
    return { path, name, info, existing } satisfies Root
  })
  const roots: Root[] = []
  described.forEach((root, index) => {
    if (root === null) skipped.push({ path: named[index]?.name ?? '', reason: 'special' })
    else roots.push(root)
  })

  const conflicting = roots.filter((root) => root.existing !== null)
  if (conflicting.length > 0 && options.onConflict === 'ask') {
    return {
      status: 'conflict',
      conflicts: conflicting.map((root) => ({
        name: root.name,
        existing: facts(root.existing as FileStat),
        incoming: facts(root.info),
        canReplace: root.existing?.kind === root.info.kind
      }))
    }
  }

  // Names this request will write, so "keep both" never picks one of them.
  const reserved = new Set(roots.filter((root) => root.existing === null).map((root) => root.name))
  const targets: Array<{ root: Root; name: string; merge: boolean }> = []
  for (const root of roots) {
    if (root.existing === null) {
      targets.push({ root, name: root.name, merge: false })
      continue
    }
    switch (options.onConflict) {
      case 'skip':
        skipped.push({ path: root.name, reason: 'exists' })
        break
      case 'replace':
        if (root.existing.kind !== root.info.kind) {
          skipped.push({ path: root.name, reason: 'kind-mismatch' })
        } else {
          reserved.add(root.name)
          targets.push({ root, name: root.name, merge: true })
        }
        break
      case 'keep-both': {
        const name = await firstFreeName(
          root.name,
          async (candidate) => reserved.has(candidate) || (await destination.stat(destination.join(destinationDirectory, candidate))) !== null
        )
        reserved.add(name)
        targets.push({ root, name, merge: false })
        break
      }
    }
  }

  const files: PlannedFile[] = []
  const folders: string[] = []

  const addFile = (file: PlannedFile): void => {
    files.push(file)
    if (files.length > limits.maxFiles) {
      throw new AppError(
        'INVALID_INPUT',
        `This selection has more than ${limits.maxFiles.toLocaleString('en-US')} files. Transfer it in smaller parts.`
      )
    }
  }

  const walk = async (sourceDirectory: string, destinationPath: string, relative: string, merge: boolean, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new AppError('INVALID_INPUT', `"${relative}" is nested more than ${limits.maxDepth} folders deep.`)
    }
    let entries
    try {
      entries = await source.list(sourceDirectory)
    } catch (error) {
      if (error instanceof AppError && error.code === 'PERMISSION_DENIED') {
        skipped.push({ path: relative, reason: 'unreadable' })
        return
      }
      throw error
    }
    if (!merge) folders.push(destinationPath)

    let existingKinds: Map<string, FileKind> | null = null
    if (merge) existingKinds = new Map((await destination.list(destinationPath)).map((entry) => [entry.name, entry.kind]))

    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of sorted) {
      const path = `${relative}/${entry.name}`
      if (!validName(entry.name, destinationPlatform)) {
        skipped.push({ path, reason: 'invalid-name' })
        continue
      }
      if (entry.kind === 'other') {
        skipped.push({ path, reason: 'special' })
        continue
      }
      if (entry.isSymlink && entry.kind === 'directory') {
        skipped.push({ path, reason: 'link-to-folder' })
        continue
      }
      const existingKind = existingKinds?.get(entry.name)
      if (existingKind !== undefined && existingKind !== entry.kind) {
        skipped.push({ path, reason: 'kind-mismatch' })
        continue
      }
      const target = destination.join(destinationPath, entry.name)
      if (entry.kind === 'directory') {
        await walk(entry.path, target, path, existingKind === 'directory', depth + 1)
      } else {
        addFile({
          sourcePath: entry.path,
          destinationPath: target,
          destinationDirectory: destinationPath,
          name: entry.name,
          relativePath: path,
          size: entry.size,
          replace: existingKind === 'file'
        })
      }
    }
  }

  for (const { root, name, merge } of targets) {
    const destinationPath = destination.join(destinationDirectory, name)
    if (root.info.kind === 'file') {
      addFile({
        sourcePath: root.path,
        destinationPath,
        destinationDirectory,
        name,
        relativePath: name,
        size: root.info.size,
        replace: merge
      })
    } else {
      await walk(root.path, destinationPath, name, merge, 1)
    }
  }

  // Parents come before their children by construction.
  for (const path of folders) await destination.mkdir(path)

  return { status: 'ready', files, folders, skipped }
}
