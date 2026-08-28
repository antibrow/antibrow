/**
 * A deliberately small subset of jq, so an agent can ask for the two fields it
 * needs instead of reading a whole result into its context. Supported:
 *
 *   .            .items       .items[]      .items[0]     .items[1:3]
 *   .a.b.c       ["odd key"]  length        keys
 *   any of the above joined with |
 *
 * Anything else is rejected by name rather than approximated: a filter that
 * quietly returns null reads exactly like a site that returned nothing.
 */

type Op =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; from?: number; to?: number }
  | { kind: 'iterate' }
  | { kind: 'length' }
  | { kind: 'keys' }

export function parseFilter(expression: string): Op[][] {
  return expression.split('|').map((part) => parseStep(part.trim(), expression))
}

function parseStep(step: string, whole: string): Op[] {
  if (step === '' || step === '.') return []
  if (step === 'length') return [{ kind: 'length' }]
  if (step === 'keys') return [{ kind: 'keys' }]

  const ops: Op[] = []
  let rest = step
  while (rest.length) {
    // `.[0]` and `[0]` mean the same thing, as in jq.
    if (rest.startsWith('.[')) rest = rest.slice(1)
    const key = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (key) {
      ops.push({ kind: 'key', key: key[1] })
      rest = rest.slice(key[0].length)
      continue
    }
    const quoted = /^\[\s*"([^"]*)"\s*\]/.exec(rest)
    if (quoted) {
      ops.push({ kind: 'key', key: quoted[1] })
      rest = rest.slice(quoted[0].length)
      continue
    }
    const slice = /^\[\s*(-?\d+)?\s*:\s*(-?\d+)?\s*\]/.exec(rest)
    if (slice && (slice[1] !== undefined || slice[2] !== undefined)) {
      ops.push({
        kind: 'slice',
        from: slice[1] === undefined ? undefined : Number(slice[1]),
        to: slice[2] === undefined ? undefined : Number(slice[2]),
      })
      rest = rest.slice(slice[0].length)
      continue
    }
    const index = /^\[\s*(-?\d+)\s*\]/.exec(rest)
    if (index) {
      ops.push({ kind: 'index', index: Number(index[1]) })
      rest = rest.slice(index[0].length)
      continue
    }
    if (/^\[\s*\]/.test(rest)) {
      ops.push({ kind: 'iterate' })
      rest = rest.replace(/^\[\s*\]/, '')
      continue
    }
    throw new Error(`unsupported filter near "${rest}" in "${whole}". Supported: .a.b, [0], [1:3], [], length, keys, and |.`)
  }
  return ops
}

function applyOp(values: unknown[], op: Op): unknown[] {
  const out: unknown[] = []
  for (const value of values) {
    if (op.kind === 'key') {
      if (value === null || value === undefined) continue
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`cannot read .${op.key} of ${Array.isArray(value) ? 'an array' : typeof value}`)
      }
      out.push((value as Record<string, unknown>)[op.key])
      continue
    }
    if (op.kind === 'length') {
      if (Array.isArray(value) || typeof value === 'string') out.push(value.length)
      else if (value && typeof value === 'object') out.push(Object.keys(value).length)
      else if (value === null || value === undefined) out.push(0)
      else throw new Error(`length of ${typeof value} is not defined`)
      continue
    }
    if (op.kind === 'keys') {
      if (Array.isArray(value)) out.push(value.map((_, i) => i))
      else if (value && typeof value === 'object') out.push(Object.keys(value).sort())
      else throw new Error('keys needs an object or an array')
      continue
    }
    if (!Array.isArray(value)) throw new Error(`cannot index ${value === null ? 'null' : typeof value} with []`)
    if (op.kind === 'iterate') out.push(...value)
    else if (op.kind === 'index') out.push(value.at(op.index))
    else out.push(value.slice(op.from ?? 0, op.to ?? value.length))
  }
  return out
}

/** One value stays one value; a stream of several comes back as an array. */
export function applyFilter(input: unknown, expression: string): unknown {
  let values: unknown[] = [input]
  for (const step of parseFilter(expression)) {
    for (const op of step) values = applyOp(values, op)
  }
  return values.length === 1 ? values[0] : values
}
