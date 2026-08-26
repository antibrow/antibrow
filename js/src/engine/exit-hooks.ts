/**
 * Close live kernels on the way out of the process.
 *
 * The kernel is spawned detached (so one signal can take its whole tree), which
 * is exactly why nothing collects it when the owner dies. SIGKILL and a power
 * cut cannot be covered here at all - `reaper.ts` sweeps up after those on the
 * next launch.
 *
 * Two closers per session, because Node's `exit` event is synchronous-only: a
 * signal can shut the browser down properly and let the archive upload finish,
 * while `exit` can do no more than kill the process tree.
 */
export interface SessionClosers {
  closeAsync: () => Promise<void>
  closeSync: () => void
}

export interface GuardHandle {
  release(): void
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
const SIGNAL_EXIT_CODE: Record<string, number> = { SIGINT: 130, SIGTERM: 143 }

export class ExitGuard {
  private readonly proc: NodeJS.Process
  private readonly entries = new Map<number, SessionClosers>()
  private next = 1
  private installed = false
  private ran = false

  constructor(proc: NodeJS.Process = process) {
    this.proc = proc
  }

  add(closers: SessionClosers): GuardHandle {
    this.install()
    const token = this.next++
    this.entries.set(token, closers)
    this.ran = false
    return { release: () => this.entries.delete(token) }
  }

  private take(): SessionClosers[] {
    if (this.ran) return []
    this.ran = true
    const pending = [...this.entries.values()]
    this.entries.clear()
    return pending
  }

  private install(): void {
    if (this.installed) return
    this.installed = true

    this.proc.on('exit', () => {
      for (const entry of this.take()) {
        try {
          entry.closeSync()
        } catch {
          // One kernel already gone must not strand the rest.
        }
      }
    })

    for (const signal of SIGNALS) {
      this.proc.on(signal, () => {
        // More than one listener means the host app handles this signal too -
        // then terminating is its call, not ours.
        const alone = this.proc.listenerCount(signal) === 1
        const pending = this.take()
        void Promise.all(
          pending.map((entry) =>
            entry.closeAsync().catch(() => {
              try {
                entry.closeSync()
              } catch {
                // already gone
              }
            }),
          ),
        ).then(() => {
          if (alone) this.proc.exit(SIGNAL_EXIT_CODE[signal] ?? 1)
        })
      })
    }
  }
}

const guard = new ExitGuard()

/** Track a session until it closes. Returns the handle that stops tracking it. */
export function guardSession(closers: SessionClosers): GuardHandle {
  return guard.add(closers)
}
