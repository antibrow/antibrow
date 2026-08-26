import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { ExitGuard } from '../../src/engine/exit-hooks'

/** Stands in for `process`: the same listener API, none of the consequences. */
class FakeProcess extends EventEmitter {
  exited: number | undefined
  exit(code?: number) {
    this.exited = code
  }
}

function guard() {
  const proc = new FakeProcess()
  return { proc, guard: new ExitGuard(proc as unknown as NodeJS.Process) }
}

describe('closing kernels on the way out', () => {
  it('kills what is still open when the process exits', () => {
    const { proc, guard: g } = guard()
    const killed: string[] = []
    g.add({ closeSync: () => killed.push('a'), closeAsync: async () => {} })

    proc.emit('exit', 0)

    expect(killed).toEqual(['a'])
  })

  it('leaves a released session alone', () => {
    const { proc, guard: g } = guard()
    const killed: string[] = []
    const handle = g.add({ closeSync: () => killed.push('a'), closeAsync: async () => {} })
    g.add({ closeSync: () => killed.push('b'), closeAsync: async () => {} })

    handle.release()
    proc.emit('exit', 0)

    expect(killed).toEqual(['b'])
  })

  it('does not strand the other sessions when one throws', () => {
    const { proc, guard: g } = guard()
    const killed: string[] = []
    g.add({
      closeSync: () => {
        throw new Error('kernel already gone')
      },
      closeAsync: async () => {},
    })
    g.add({ closeSync: () => killed.push('b'), closeAsync: async () => {} })

    proc.emit('exit', 0)

    expect(killed).toEqual(['b'])
  })

  it('closes gracefully on SIGTERM, so the archive still gets uploaded', async () => {
    const { proc, guard: g } = guard()
    const order: string[] = []
    g.add({ closeSync: () => order.push('kill'), closeAsync: async () => void order.push('graceful') })

    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))

    expect(order).toEqual(['graceful'])
  })

  it('still terminates after handling SIGTERM itself', async () => {
    const { proc, guard: g } = guard()
    g.add({ closeSync: () => {}, closeAsync: async () => {} })

    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))

    expect(proc.exited).toBe(143)
  })

  it('leaves termination to the host app when it handles the signal too', async () => {
    const { proc, guard: g } = guard()
    proc.on('SIGTERM', () => {})
    g.add({ closeSync: () => {}, closeAsync: async () => {} })

    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))

    expect(proc.exited).toBeUndefined()
  })

  it('runs the sync path only once even if exit is reached twice', () => {
    const { proc, guard: g } = guard()
    const killed: string[] = []
    g.add({ closeSync: () => killed.push('a'), closeAsync: async () => {} })

    proc.emit('exit', 0)
    proc.emit('exit', 0)

    expect(killed).toEqual(['a'])
  })

  it('installs its process listeners only once', () => {
    const { proc, guard: g } = guard()
    g.add({ closeSync: () => {}, closeAsync: async () => {} })
    g.add({ closeSync: () => {}, closeAsync: async () => {} })

    expect(proc.listenerCount('exit')).toBe(1)
    expect(proc.listenerCount('SIGTERM')).toBe(1)
  })
})
