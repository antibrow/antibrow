"""E2E (Linux container): a real WebGL context, and a lock from another host.

Both failures are invisible on macOS and Windows: the container-only switch
block used to turn the GPU off entirely, and only Linux/containers see the host
name inside SingletonLock change between runs.

Requires ANTIBROW_API_KEY, and an Xvfb display. Optional: ADB_PROXY, ADB_CACHE,
ADB_PROFILE.

Run (inside a Linux container):
    python tests/e2e_linux_webgl.py
"""
import json
import os
import sys
from pathlib import Path

import antibrow

PROFILE = os.environ.get("ADB_PROFILE", "e2e-py-webgl")
CACHE = os.environ.get("ADB_CACHE") or None
PROXY = os.environ.get("ADB_PROXY") or None

READ_WEBGL = """() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!gl) return { context: false };
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    context: true,
    renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    extensions: (gl.getSupportedExtensions() || []).length,
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
  };
}"""

failures = []
def check(ok, label, detail=""):
    print("  {0}  {1}{2}".format("PASS" if ok else "FAIL", label, " - {0}".format(detail) if detail else ""))
    if not ok:
        failures.append(label)

def opened():
    return antibrow.launch(
        PROFILE, focus_window=False, proxy=PROXY, cache_dir=CACHE,
        on_progress=lambda m: print("  [progress] {0}".format(m)),
    )

print("[1/2] WebGL is a real context and reports the persona GPU")
session = opened()
profile_dir = Path(session.profile_dir)
try:
    page = session.page
    page.goto("https://example.com", wait_until="domcontentloaded", timeout=60000)
    gl = page.evaluate(READ_WEBGL)
    print("  " + json.dumps(gl))
    check(gl.get("context"), "getContext(webgl) returns a context")
    check(gl.get("webgl2"), "getContext(webgl2) returns a context")
    r = gl.get("renderer") or ""
    check(r.startswith("ANGLE ("), "renderer is an ANGLE string", r)
    check("Direct3D11" in r, "renderer claims D3D11, not the host GL", r)
    check(not any(s in r for s in ("SwiftShader", "llvmpipe", "Mesa")), "no software backend leaks through", r)
    check((gl.get("maxTextureSize") or 0) >= 8192, "MAX_TEXTURE_SIZE is a desktop value", str(gl.get("maxTextureSize")))
finally:
    session.close()

print()
print("[2/2] a lock written by another host does not block the next start")
lock = profile_dir / "user-data" / "SingletonLock"
lock.unlink(missing_ok=True)
os.symlink("6c7045e44f1b-25", lock)
session = opened()
try:
    check(True, "profile opened with a foreign host lock present")
finally:
    session.close()

print()
if failures:
    print("FAILED: {0}".format(", ".join(failures)))
    sys.exit(1)
print("All checks passed.")
