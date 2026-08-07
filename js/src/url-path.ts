/**
 * Percent-encode a value for use as one path segment.
 *
 * Not `encodeURIComponent`: it also escapes characters a path segment may carry
 * raw, and the result trips the server's double-encoding guard. That guard
 * refuses any segment which partially decodes and still holds a `%xx`, and
 * `decodeURI` decodes `%20` while leaving `%40` - so a profile named
 * `work mail@example.com` is rejected before any route matches, which shows up
 * as cloud sync quietly never working for that profile.
 *
 * Leaving RFC 3986's sub-delims, `:` and `@` raw keeps the segment single-level.
 * `#` and `%` have no raw spelling, so a name holding one of those *and* a space
 * is still refused; both are rare in a profile name.
 */
const RAW_IN_SEGMENT: Record<string, string> = {
  '%21': '!', '%24': '$', '%26': '&', '%27': "'", '%28': '(', '%29': ')',
  '%2A': '*', '%2B': '+', '%2C': ',', '%3A': ':', '%3B': ';', '%3D': '=', '%40': '@',
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => RAW_IN_SEGMENT[m] ?? m)
}
