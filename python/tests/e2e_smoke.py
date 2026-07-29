"""Real end-to-end smoke test: downloads nothing, fakes nothing, launches.

Not collected by pytest (the filename is deliberately not ``test_*``) because it
needs a license and a real browser. Run it by hand after a change to the launch
path:

    python -m antibrow login            # or export ANTIBROW_API_KEY / ANTIBROW_LICENSE_TOKEN
    python tests/e2e_smoke.py

It asserts that the fingerprint the page reports actually matches the persona on
disk - which is the only check that proves the whole chain (persona ->
fp-config -> kernel -> Blink -> JS) is wired up.
"""

from __future__ import annotations

from antibrow import launch

PROFILE = "e2e-smoke"

PROBE = """() => ({
  ua: navigator.userAgent,
  platform: navigator.platform,
  languages: navigator.languages,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  maxTouchPoints: navigator.maxTouchPoints,
  screen: [screen.width, screen.height, screen.availHeight, screen.colorDepth],
  dpr: devicePixelRatio,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  webgl: (() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return [null, null];
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? [gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)]
      : [null, null];
  })(),
  canvas: (() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('antibrow', 2, 2);
    return c.toDataURL().slice(-32);
  })(),
})"""


def main() -> int:
    failures = []

    def check(name, actual, expected):
        ok = actual == expected
        print("  {0:<22} {1}  {2}".format(name, "ok " if ok else "FAIL", actual))
        if not ok:
            failures.append("{0}: expected {1!r}, got {2!r}".format(name, expected, actual))

    print("launching...")
    with launch(profile=PROFILE, headless=True, on_progress=lambda m: print("  ", m)) as browser:
        persona = browser.persona
        print("\nkernel {0} | profile {1}".format(browser.kernel_version, browser.profile_dir))

        page = browser.new_page()
        page.goto("https://example.com", wait_until="domcontentloaded")
        seen = page.evaluate(PROBE)

        print("\nfingerprint vs persona:")
        check("userAgent", seen["ua"], persona.ua)
        check("platform", seen["platform"], "Win32")
        check("languages", list(seen["languages"]), persona.languages)
        check("hardwareConcurrency", seen["hardwareConcurrency"], persona.hardware_concurrency)
        check("deviceMemory", seen["deviceMemory"], persona.device_memory)
        check("maxTouchPoints", seen["maxTouchPoints"], 0)
        check("screen.width", seen["screen"][0], persona.screen_w)
        check("screen.height", seen["screen"][1], persona.screen_h)
        check("screen.availHeight", seen["screen"][2], persona.screen_h - 48)
        check("devicePixelRatio", seen["dpr"], persona.device_pixel_ratio)
        check("timezone", seen["timezone"], browser.timezone)
        check("webgl vendor", seen["webgl"][0], persona.gpu_vendor)
        check("webgl renderer", seen["webgl"][1], persona.gpu_renderer)

        # Canvas noise must be deterministic: same profile, same hash, always.
        second = page.evaluate(PROBE)["canvas"]
        check("canvas determinism", second, seen["canvas"])
        print("\n  canvas tail:", seen["canvas"])

    print()
    if failures:
        print("FAILED ({0}):".format(len(failures)))
        for line in failures:
            print("  -", line)
        return 1
    print("all fingerprint assertions passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
