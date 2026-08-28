/**
 * The in-page half of the recipe runtime.
 *
 * A recipe's `run()` executes inside the page the runtime opened, not in Node:
 * a same-origin `fetch` there carries the profile's session for that site
 * without the SDK ever touching a cookie, and a site with no JSON endpoint can
 * be read straight off the DOM. It also means the two SDKs share one execution
 * model instead of one of them reimplementing the recipe format.
 *
 * CTX_SOURCE must stay byte-identical to the Python SDK's copy - one recipe has
 * to produce the same output from either SDK. `test_recipe_bootstrap.py`
 * compares them.
 */

/** Members a recipe may use. Declared here, documented in the recipes GUIDE. */
export const CTX_SOURCE = `{
  profileName: payload.profileName,
  log: function (message) {
    try {
      if (window.__antibrowRecipeLog) window.__antibrowRecipeLog(String(message))
    } catch (error) { /* logging must never fail a run */ }
  },
  sleep: function (ms) {
    var wait = Math.min(Math.max(Number(ms) || 0, 0), 30000)
    return new Promise(function (resolve) { setTimeout(resolve, wait) })
  },
  fetchText: async function (path, init) {
    var target = new URL(String(path), location.href)
    var res = await fetch(target.toString(), Object.assign({ credentials: 'include' }, init || {}))
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + target.host + target.pathname)
    return await res.text()
  },
  fetchJson: async function (path, init) {
    var text = await this.fetchText(path, init)
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error('response is not json: ' + text.slice(0, 200))
    }
  },
}`

/**
 * `export` is stripped instead of the file being imported as a module: the
 * source is embedded in one expression the debugger protocol evaluates, which is
 * the only way in that a page's own Content-Security-Policy cannot veto. A
 * blob import or `new Function` inside the page is subject to it, and the sites
 * worth writing a recipe for are exactly the ones that set a strict policy.
 */
export function stripExports(source: string): string {
  return source.replace(/^[ \t]*export\s+(?=(?:const|let|var|async|function|class)\b)/gm, '')
}

/**
 * The recipe body goes inside its own closure so a recipe declaring `ctx`,
 * `payload` or anything else at top level cannot collide with the runtime's own
 * names - a collision would be a syntax error at run time, on the user's
 * machine, for a file we did not write.
 *
 * The payload is serialized INTO the expression rather than passed as an
 * argument: both Playwright clients set `isFunction` from the JavaScript type
 * of what they are handed, so a string page function always arrives with
 * `isFunction: false` and the argument is dropped. Evaluating it as a bare
 * expression then yields the wrapper function itself, which serializes back as
 * `undefined` - a recipe that appears to run and return nothing.
 *
 * The deadline is enforced in the page as well as around the call: the Python
 * SDK's synchronous Playwright API has nothing to race an evaluation against,
 * and both SDKs have to cut a slow recipe off at the same point.
 */
export function buildRunnerExpression(source: string, payload: RecipePayload): string {
  return `(async () => {
  const payload = ${encodePayload(payload)}
  const __abctx = ${CTX_SOURCE}
  const __abmod = (() => {
${stripExports(source)}
    return { meta: typeof meta === 'undefined' ? undefined : meta, run: run }
  })()
  if (typeof __abmod.run !== 'function') throw new Error('recipe exports no run()')
  const __abrun = __abmod.run(__abctx, payload.args)
  if (!(payload.timeoutMs > 0)) return await __abrun
  return await Promise.race([__abrun, new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('recipe timed out after ' + payload.timeoutMs + 'ms')), payload.timeoutMs)
  })])
})()`
}

export interface RecipePayload {
  args: Record<string, unknown>
  profileName: string
  timeoutMs: number
}

/**
 * The two line terminators JSON allows raw inside a string but older JavaScript
 * parsers reject there. The Python SDK escapes the same two, so one recipe
 * produces one expression from either SDK.
 */
export function encodePayload(payload: RecipePayload): string {
  return JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
