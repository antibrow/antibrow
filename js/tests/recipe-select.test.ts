import { describe, it, expect } from 'vitest'
import { applyFilter } from '../src/recipe/select'

const payload = {
  items: [
    { id: 'a', title: 'first', score: 3 },
    { id: 'b', title: 'second', score: 9 },
    { id: 'c', title: 'third', score: 1 },
  ],
  meta: { count: 3 },
}

describe('applyFilter', () => {
  it('returns the input for . and an empty filter', () => {
    expect(applyFilter(payload, '.')).toBe(payload)
    expect(applyFilter(payload, '')).toBe(payload)
  })

  it('walks a path', () => {
    expect(applyFilter(payload, '.meta.count')).toBe(3)
  })

  it('iterates and projects', () => {
    expect(applyFilter(payload, '.items[].title')).toEqual(['first', 'second', 'third'])
  })

  it('indexes, including from the end', () => {
    expect(applyFilter(payload, '.items[0].id')).toBe('a')
    expect(applyFilter(payload, '.items[-1].id')).toBe('c')
  })

  it('slices', () => {
    expect(applyFilter(payload, '.items[0:2] | .[].id')).toEqual(['a', 'b'])
  })

  it('counts', () => {
    expect(applyFilter(payload, '.items | length')).toBe(3)
    expect(applyFilter(payload, '.meta | keys')).toEqual(['count'])
  })

  it('reads a key that is not an identifier', () => {
    expect(applyFilter({ 'odd key': 7 }, '.["odd key"]')).toBe(7)
  })

  it('keeps a single-element stream a single value', () => {
    expect(applyFilter({ items: [{ id: 'only' }] }, '.items[].id')).toBe('only')
  })

  // A filter that silently returns null reads exactly like a site that returned
  // nothing, so anything outside the subset has to say so.
  it('rejects an unsupported expression by name', () => {
    expect(() => applyFilter(payload, '.items | map(.title)')).toThrow(/unsupported filter/)
    expect(() => applyFilter(payload, '.items[] | select(.score > 2)')).toThrow(/unsupported filter/)
  })

  it('rejects indexing a non-array', () => {
    expect(() => applyFilter(payload, '.meta[]')).toThrow(/cannot index/)
  })

  it('reads through a missing key without throwing', () => {
    expect(applyFilter(payload, '.nope')).toBeUndefined()
  })
})
