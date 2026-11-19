export type VersionStatus = 'ok' | 'recommended' | 'required'

function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((seg) => parseInt(seg, 10) || 0)
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

export function evaluateVersion(current: string, policy: { latest: string; minSupported: string }): VersionStatus {
  if (compareVersions(current, policy.minSupported) < 0) return 'required'
  if (compareVersions(current, policy.latest) < 0) return 'recommended'
  return 'ok'
}
