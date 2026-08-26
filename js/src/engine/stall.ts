/**
 * Bounding transfers by silence rather than by wall clock.
 *
 * A first kernel install is hundreds of megabytes and a cloud archive can be
 * tens; an absolute timeout on either just decides how fast a connection has to
 * be before the SDK stops working. What is never legitimate is receiving
 * nothing at all for a minute, which is exactly what a wedged proxy or a dropped
 * connection looks like.
 */
export class StallTimeoutError extends Error {
  constructor(stallMs: number) {
    super(`Transfer stalled: no data for ${Math.round(stallMs / 1000)}s`)
    this.name = 'StallTimeoutError'
  }
}

/** Drain `stream`, failing if any gap between chunks exceeds `stallMs`. */
export async function readAllWithStall(
  stream: AsyncIterable<Uint8Array>,
  stallMs: number,
  onProgress?: (bytes: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  const iterator = stream[Symbol.asyncIterator]()
  for (;;) {
    let timer: NodeJS.Timeout | undefined
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StallTimeoutError(stallMs)), stallMs)
      // The race is only a guard - it must not hold the process open.
      timer.unref?.()
    })

    let step: IteratorResult<Uint8Array>
    try {
      step = await Promise.race([iterator.next(), stalled])
    } catch (e) {
      // Not awaited: a generator suspended on a promise that never settles can
      // never finish its return either, and waiting on that is the same hang
      // this guard exists to break.
      void iterator.return?.()?.catch?.(() => undefined)
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (step.done) break
    const chunk = Buffer.from(step.value)
    chunks.push(chunk)
    total += chunk.length
    onProgress?.(total)
  }

  return Buffer.concat(chunks, total)
}
