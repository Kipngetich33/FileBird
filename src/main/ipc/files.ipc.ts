import { IPC } from '../../shared/constants/channels'
import { MAX_DELETE_ITEMS, MAX_MOVE_ITEMS, type DeleteOutcome, type FileTarget, type MoveOutcome } from '../../shared/types/file-operations'
import { AppError } from '../errors'
import type { FileOperationsService } from '../services/file-operations.service'
import { handle } from './handle'
import { assertAbsolutePath, assertObject, assertRemotePath, assertString, assertUuid } from './validate'

function assertTarget(value: unknown): FileTarget {
  const target = assertObject(value, 'target')
  if (target['side'] === 'local') return { side: 'local' }
  if (target['side'] === 'remote') return { side: 'remote', connectionId: assertUuid(target['connectionId'], 'connectionId') }
  throw new AppError('INVALID_INPUT', 'Unknown side.')
}

/** Paths are checked for the side they live on: platform paths locally, POSIX remotely. */
const pathFor = (target: FileTarget, value: unknown, field: string): string =>
  target.side === 'local' ? assertAbsolutePath(value, field) : assertRemotePath(value, field)

/** Create folder, rename and delete (Milestone 8). Names are checked again in the service. */
export function registerFilesIpc(operations: FileOperationsService): void {
  handle<string>(IPC.FILES_CREATE_FOLDER, (rawTarget, parent, name) => {
    const target = assertTarget(rawTarget)
    return operations.createFolder(target, pathFor(target, parent, 'parent'), assertString(name, 'name', 1024))
  })

  handle<string>(IPC.FILES_RENAME, (rawTarget, path, newName) => {
    const target = assertTarget(rawTarget)
    return operations.rename(target, pathFor(target, path, 'path'), assertString(newName, 'newName', 1024))
  })

  handle<DeleteOutcome>(IPC.FILES_DELETE, (rawTarget, paths) => {
    const target = assertTarget(rawTarget)
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DELETE_ITEMS) {
      throw new AppError('INVALID_INPUT', `Choose between 1 and ${MAX_DELETE_ITEMS} items to delete.`)
    }
    return operations.delete(target, paths.map((path: unknown) => pathFor(target, path, 'paths')))
  })

  handle<MoveOutcome>(IPC.FILES_MOVE, (rawTarget, paths, destination) => {
    const target = assertTarget(rawTarget)
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_MOVE_ITEMS) {
      throw new AppError('INVALID_INPUT', `Choose between 1 and ${MAX_MOVE_ITEMS} items to move.`)
    }
    return operations.move(
      target,
      paths.map((path: unknown) => pathFor(target, path, 'paths')),
      pathFor(target, destination, 'destination')
    )
  })
}
