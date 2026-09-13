import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errnoOf } from '../errors'
import { createLogger } from '../logger'

const log = createLogger('storage')

export interface JsonDocumentOptions<T> {
  path: string
  /** The value for a missing (or set-aside) file. */
  empty: () => T
  /** Turns parsed JSON into a trusted value. Throw to treat the file as corrupt. */
  parse: (value: unknown) => T
}

/**
 * One JSON file in the app's data folder, shared by the trust store and saved
 * connections.
 *
 * Writes are serialised and atomic (temp file + rename, mode 0600), so a crash
 * mid-write can't leave half a file. A file that can't be parsed is set aside
 * for inspection rather than silently overwritten.
 */
export class JsonDocument<T> {
  private readonly options: JsonDocumentOptions<T>
  private pending: Promise<unknown> = Promise.resolve()

  constructor(options: JsonDocumentOptions<T>) {
    this.options = options
  }

  async read(): Promise<T> {
    await this.pending
    return this.load()
  }

  /** Applies `change` to the current value and writes the result. */
  update(change: (current: T) => T): Promise<T> {
    const run = this.pending.then(async () => {
      const next = change(await this.load())
      await this.write(next)
      return next
    })
    // A failed write must not wedge every later one.
    this.pending = run.catch(() => undefined)
    return run
  }

  private async load(): Promise<T> {
    const { path, empty, parse } = this.options
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return empty()
      throw error
    }

    try {
      return parse(JSON.parse(text))
    } catch (error) {
      const aside = `${path}.corrupt-${Date.now()}`
      await rename(path, aside).catch(() => undefined)
      log.warn('Unreadable data file set aside', {
        aside,
        error: error instanceof Error ? error.message : String(error)
      })
      return empty()
    }
  }

  private async write(value: T): Promise<void> {
    const { path } = this.options
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path)
  }
}
