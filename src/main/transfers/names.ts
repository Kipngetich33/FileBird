import { nameProblem } from '../../shared/names'
import { AppError } from '../errors'

/**
 * A single file name that is safe to create on the destination side. Remote
 * names can contain characters a local file system rejects, and no name may
 * climb out of the destination folder. The rules live in shared/names.ts.
 */
export function assertTransferName(name: string, platform: NodeJS.Platform = process.platform): string {
  const problem = nameProblem(name, platform)
  if (problem !== null) throw new AppError('INVALID_INPUT', `"${name}" can't be used as a name here. ${problem}`)
  return name
}

/**
 * "Keep both": report.pdf → report (1).pdf → report (2).pdf. A leading dot is
 * part of the name, not an extension (.bashrc → .bashrc (1)).
 */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name} (${n})`
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}

/** The first "name (n)" for which `exists` is false. */
export async function firstFreeName(name: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = numberedName(name, n)
    if (!(await exists(candidate))) return candidate
  }
  throw new AppError('TRANSFER_FAILED', `Couldn't find a free name for "${name}".`)
}

/** A hidden temporary name beside the destination, so a failed transfer never takes the real name. */
export function temporaryName(name: string, suffix: string): string {
  return `.${name.slice(0, 200)}.fly-part-${suffix}`
}
