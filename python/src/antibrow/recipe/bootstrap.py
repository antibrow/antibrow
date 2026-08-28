"""The in-page half of the recipe runtime.

A recipe's ``run()`` executes inside the page the runtime opened, not in Python:
a same-origin ``fetch`` there carries the profile's session for that site
without this SDK ever touching a cookie, and a site with no JSON endpoint can be
read straight off the DOM. It also means both SDKs share one execution model
instead of one of them reimplementing the recipe format.

:data:`CTX_SOURCE` and the wrapper below are byte-identical to the Node SDK's -
one recipe has to produce the same output from either SDK, and
``test_recipe_bootstrap.py`` compares the two files.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

#: Members a recipe may use. Documented in the recipes GUIDE.
CTX_SOURCE = """{
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
}"""

_PRE = """(async () => {
  const payload = """
_MID_CTX = """
  const __abctx = """
_MID_SOURCE = """
  const __abmod = (() => {
"""
_POST = """
    return { meta: typeof meta === 'undefined' ? undefined : meta, run: run }
  })()
  if (typeof __abmod.run !== 'function') throw new Error('recipe exports no run()')
  const __abrun = __abmod.run(__abctx, payload.args)
  if (!(payload.timeoutMs > 0)) return await __abrun
  return await Promise.race([__abrun, new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('recipe timed out after ' + payload.timeoutMs + 'ms')), payload.timeoutMs)
  })])
})()"""

_EXPORT_RE = re.compile(r"^[ \t]*export\s+(?=(?:const|let|var|async|function|class)\b)", re.M)


def strip_exports(source: str) -> str:
    """Drop the two ``export`` keywords the recipe format allows.

    The source is embedded in one expression the debugger protocol evaluates,
    which is the only way in that a page's own Content-Security-Policy cannot
    veto - a blob import or ``new Function`` inside the page is subject to it,
    and the sites worth writing a recipe for are exactly the ones that set a
    strict policy.
    """
    return _EXPORT_RE.sub("", source)


def encode_payload(payload: Dict[str, Any]) -> str:
    """Serialize the payload the way ``JSON.stringify`` does.

    Compact separators and no ASCII escaping, so the expression this builds is
    byte-identical to the Node SDK's. The two line terminators JSON allows raw
    inside a string but older JavaScript parsers reject there are escaped.
    """
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build_runner_expression(source: str, payload: Dict[str, Any]) -> str:
    """Wrap a recipe so its own top-level names cannot collide with the runtime's.

    The payload is serialized *into* the expression rather than passed as an
    argument: both Playwright clients decide ``isFunction`` from the type of what
    they are handed, so a string page function always arrives with
    ``isFunction: False`` and the argument is dropped - the wrapper would then be
    evaluated as a bare expression and come back as ``None``.
    """
    return (
        _PRE
        + encode_payload(payload)
        + _MID_CTX
        + CTX_SOURCE
        + _MID_SOURCE
        + strip_exports(source)
        + _POST
    )
