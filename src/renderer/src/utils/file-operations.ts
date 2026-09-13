import type { DeleteOutcome } from '@shared/types/file-operations'

const NAMES_SHOWN = 3

/** '"a.txt", "b.txt" and 3 more' */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map((name) => `"${name}"`)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  if (shown.length <= 1) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** A summary for a delete in which something went wrong; null when everything was deleted. */
export function describeDeleteOutcome(outcome: DeleteOutcome, requested: number, trash: boolean): string | null {
  const [first, ...others] = outcome.failures
  if (first === undefined) return null
  const reason = `"${first.name}": ${first.error.message}${others.length > 0 ? ` (${others.length} more couldn't be ${trash ? 'moved' : 'deleted'} either)` : ''}`
  if (outcome.deleted === 0) return requested === 1 ? `Couldn't ${trash ? 'move to the Trash' : 'delete'} ${reason}` : `Nothing was ${trash ? 'moved' : 'deleted'}. ${reason}`
  return `${trash ? 'Moved' : 'Deleted'} ${outcome.deleted} of ${requested} items. ${reason}`
}
