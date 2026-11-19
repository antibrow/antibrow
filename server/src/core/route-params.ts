// Path params can arrive still percent-encoded (some adapters hand the raw
// segment through), so `a@b.com` would be looked up as `a%40b.com`. A segment
// that is not valid escaping (a bare `%`) is passed through untouched.
export function decodeRouteParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
