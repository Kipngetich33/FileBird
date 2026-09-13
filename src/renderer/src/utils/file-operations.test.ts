import { describe, expect, it } from 'vitest'
import { describeDeleteOutcome, listNames } from './file-operations'

const failure = (name: string, message = 'No permission.') => ({ name, path: `/x/${name}`, error: { code: 'PERMISSION_DENIED' as const, message } })

describe('listNames', () => {
  it('lists a few names and counts the rest', () => {
    expect(listNames(['a'])).toBe('"a"')
    expect(listNames(['a', 'b'])).toBe('"a" and "b"')
    expect(listNames(['a', 'b', 'c'])).toBe('"a", "b" and "c"')
    expect(listNames(['a', 'b', 'c', 'd', 'e'])).toBe('"a", "b", "c" and 2 more')
  })
})

describe('describeDeleteOutcome', () => {
  it('is silent when everything was deleted', () => {
    expect(describeDeleteOutcome({ deleted: 3, failures: [] }, 3, false)).toBeNull()
  })

  it('explains a partial delete with the first reason', () => {
    expect(describeDeleteOutcome({ deleted: 1, failures: [failure('locked'), failure('other')] }, 3, false)).toBe(
      `Deleted 1 of 3 items. "locked": No permission. (1 more couldn't be deleted either)`
    )
  })

  it('words a failed single item and a trash move', () => {
    expect(describeDeleteOutcome({ deleted: 0, failures: [failure('a.txt', 'Gone.')] }, 1, true)).toBe(`Couldn't move to the Trash "a.txt": Gone.`)
    expect(describeDeleteOutcome({ deleted: 0, failures: [failure('a'), failure('b')] }, 2, false)).toBe(
      `Nothing was deleted. "a": No permission. (1 more couldn't be deleted either)`
    )
  })
})
