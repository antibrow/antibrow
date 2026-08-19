/**
 * Retry for the cloud API.
 *
 * The account's rate limit is shared by every lane running under one API key,
 * so a parallel workload throttles itself: a single launch spends several
 * `/api/v1/` calls, and N of them starting together arrive as one burst. Every
 * call site used to turn that 429 into a hard failure — or, worse, into a
 * silent "this profile is local-only" — which is how a run could finish with
 * its cloud profile never written.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** Attempts including the first. */
export const RETRY_MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
/** One full rate-limit window; a shorter cap would retry inside it and waste the attempt. */
const MAX_DELAY_MS = 65_000
/** Jitter ceiling; the actual spread scales with the wait, so a 500ms backoff
 *  does not get a multi-second tail. */
const MAX_JITTER_MS = 4_000
/** Total time retries may add to one call, so a throttled launch fails fast instead of hanging. */
const RETRY_BUDGET_MS = 90_000

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  const base = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : BASE_BACKOFF_MS * 2 ** (attempt - 1)
  // Jitter is added, never subtracted: Retry-After is when the window actually
  // resets, and every lane sharing the key is handed the same number, so an
  // un-spread retry rebuilds the burst that caused the 429.
  const delay = Math.min(MAX_DELAY_MS, base)
  return delay + Math.floor(Math.random() * Math.min(delay, MAX_JITTER_MS))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `fetch` that rides out throttling and transient failures. Returns the last
 * response even when it is still an error, so callers keep their own status
 * handling; only a transport failure with no response left rethrows.
 */
export async function retryFetch(url: string, init?: RequestInit): Promise<Response> {
  let spent = 0
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined
    try {
      response = await fetch(url, init)
      if (!RETRYABLE_STATUS.has(response.status)) return response
    } catch (error) {
      if (attempt >= RETRY_MAX_ATTEMPTS) throw error
    }

    if (attempt >= RETRY_MAX_ATTEMPTS) return response!
    const delay = retryDelayMs(attempt, response?.headers.get('Retry-After') ?? null)
    // Sleeping past the budget would trade a clear error for a stalled launch.
    if (spent + delay > RETRY_BUDGET_MS) return response!
    spent += delay
    await sleep(delay)
  }
}
