"""The shortest useful script: launch, browse, close.

    python examples/01_basic.py

Needs an API key (`python -m antibrow login`, or $ANTIBROW_API_KEY). The first
run also downloads the browser kernel, which takes a minute.
"""

from antibrow import launch


def main() -> None:
    # No arguments: profile "default", headful, no proxy.
    browser = launch(on_progress=print)

    page = browser.new_page()
    page.goto("https://abrahamjuliot.github.io/creepjs/", wait_until="domcontentloaded")
    page.wait_for_timeout(8000)  # CreepJS needs a moment to finish its probes

    print("title:      ", page.title())
    print("user agent: ", page.evaluate("navigator.userAgent"))
    print("timezone:   ", page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"))
    print("screen:     ", page.evaluate("[screen.width, screen.height, devicePixelRatio]"))
    print("renderer:   ", page.evaluate(
        """() => {
            const gl = document.createElement('canvas').getContext('webgl');
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        }"""
    ))

    page.screenshot(path="creepjs.png", full_page=True)
    print("saved creepjs.png")

    browser.close()


if __name__ == "__main__":
    main()
