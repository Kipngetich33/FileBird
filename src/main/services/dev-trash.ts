import { randomBytes } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** A stand-in Trash for tests and unpackaged builds: moves items into a folder under a unique name. */
export function devTrash(directory: string): (path: string) => Promise<void> {
  return async (path) => {
    await mkdir(directory, { recursive: true })
    await rename(path, join(directory, `${basename(path)}-${randomBytes(4).toString('hex')}`))
  }
}
