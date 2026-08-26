import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One budget for the whole launch.
 *
 * Every network step had its own timeout, but nothing added them up - and most
 * of them had none at all: a launch could sit through a slow license call, a
 * slow archive probe and a wedged proxy in series with no upper bound, while
 * the caller's `timeout` only ever covered spawning the kernel.
 *
 * Kernel downloads and archive transfers deliberately stay *out* of this
 * budget: a first install is hundreds of megabytes. Those are bounded by a
 * stall timeout instead - no bytes for N seconds - so slow-but-moving survives
 * and actually-dead does not.
 *
 * All times are milliseconds.
 */
export class LaunchTimeoutError extends Error {
  readonly step?: string
  constructor(message: string, step?: string) {
    super(message)
    this.name = 'LaunchTimeoutError'
    this.step = step
  }
}

export class Deadline {
  private readonly total?: number
  private readonly clock: () => number
  private started: number
  private currentStep?: string

  constructor(totalMs: number | undefined, clock: () => number = Date.now, step?: string) {
    this.total = totalMs && totalMs > 0 ? totalMs : undefined
    this.clock = clock
    this.started = clock()
    this.currentStep = step
  }

  get step(): string | undefined {
    return this.currentStep
  }

  remaining(): number {
    if (this.total === undefined) return Infinity
    return this.total - (this.clock() - this.started)
  }

  /** Note which step is starting, and stop if the budget is already spent. */
  check(step?: string): void {
    if (step !== undefined) this.currentStep = step
    if (this.remaining() <= 0) throw this.expired()
  }

  /** The timeout for one step: its own, or what is left, whichever is less. */
  budget(defaultMs: number): number {
    const left = this.remaining()
    if (left <= 0) throw this.expired()
    return left === Infinity ? defaultMs : Math.min(defaultMs, left)
  }

  /** Run a stretch the budget must not be charged for - a download, a restore. */
  async paused<T>(fn: () => Promise<T>): Promise<T> {
    const entered = this.clock()
    try {
      return await fn()
    } finally {
      this.started += this.clock() - entered
    }
  }

  private expired(): LaunchTimeoutError {
    const where = this.currentStep ? ` while ${this.currentStep}` : ''
    return new LaunchTimeoutError(
      `Launch timed out after ${Math.round((this.total ?? 0) / 1000)}s${where}`,
      this.currentStep,
    )
  }
}

const store = new AsyncLocalStorage<Deadline>()

/** Publish `deadline` so every HTTP call inside `fn` shrinks to fit it. */
export function withDeadline<T>(deadline: Deadline, fn: () => Promise<T>): Promise<T> {
  return store.run(deadline, fn)
}

export function currentDeadline(): Deadline | undefined {
  return store.getStore()
}

/**
 * Timeout for one call under the active budget, or undefined when it is spent -
 * the caller must not fall back to its own timeout, and must not pass 0 to a
 * socket either (that is a non-blocking socket, not an instant failure).
 */
export function remainingBudget(defaultMs: number): number | undefined {
  const deadline = store.getStore()
  if (!deadline) return defaultMs
  const left = deadline.remaining()
  if (left <= 0) return undefined
  return left === Infinity ? defaultMs : Math.min(defaultMs, left)
}
