import { describe, it, expect } from 'vitest'
import { encodePathSegment } from '../src/url-path'

/**
 * The server rejects a path segment that partially decodes and still holds a
 * `%xx` - it reads as double encoding. `encodeURIComponent` walks straight into
 * it: a name with a space *and* an `@` becomes `%20…%40`, `decodeURI` turns the
 * space back but leaves `%40`, and the request is refused before any route
 * matches. For a profile that means cloud sync silently stops working.
 *
 * This is the invariant that keeps a name addressable.
 */
function tripsTheGuard(segment: string): boolean {
  const decoded = decodeURI(segment)
  return decoded !== segment && /%[0-9a-fA-F]{2}/.test(decoded)
}

describe('encodePathSegment', () => {
  it('keeps a name with a space and an @ single-level', () => {
    const name = 'work mail@example.com'
    expect(tripsTheGuard(encodeURIComponent(name))).toBe(true)   // the old spelling
    expect(tripsTheGuard(encodePathSegment(name))).toBe(false)
    expect(encodePathSegment(name)).toBe('work%20mail@example.com')
  })

  it('leaves every character a path segment may carry raw', () => {
    // RFC 3986 pchar: unreserved / pct-encoded / sub-delims / ":" / "@"
    const raw = "abc-._~!$&'()*+,;=:@"
    expect(encodePathSegment(raw)).toBe(raw)
  })

  it('still escapes what a segment cannot carry', () => {
    expect(encodePathSegment('a/b')).toBe('a%2Fb')
    expect(encodePathSegment('a?b')).toBe('a%3Fb')
    expect(encodePathSegment('a#b')).toBe('a%23b')
    expect(encodePathSegment('a b')).toBe('a%20b')
    expect(encodePathSegment('a%b')).toBe('a%25b')
  })

  it('round-trips through the decoding the server does', () => {
    for (const name of [
      'work mail@example.com',
      'gmail-agauche11',
      'café résumé',
      "o'brien+tag",
      'a:b;c=d,e',
      'plain',
    ]) {
      expect(decodeURIComponent(encodePathSegment(name))).toBe(name)
      expect(tripsTheGuard(encodePathSegment(name))).toBe(false)
    }
  })

  it('encodes non-ASCII as UTF-8, which decodes cleanly on its own', () => {
    expect(encodePathSegment('café')).toBe('caf%C3%A9')
    expect(tripsTheGuard('a%20caf%C3%A9')).toBe(false)
  })

  it('is honest about the case it cannot fix', () => {
    // `#` and `%` have no raw spelling in a path, so a name holding one *and* a
    // space still trips the guard. Rare enough to document rather than design
    // around, but not something to claim is handled.
    expect(tripsTheGuard(encodePathSegment('a b#c'))).toBe(true)
    // A literal `%` only bites when hex digits follow it, since that is what
    // the guard looks for once `%25` has decoded back to `%`.
    expect(tripsTheGuard(encodePathSegment('a b%ccc'))).toBe(true)
    expect(tripsTheGuard(encodePathSegment('a b%zz'))).toBe(false)
  })
})
