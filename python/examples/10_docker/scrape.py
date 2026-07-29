"""What runs inside the container - a normal antibrow script.

Nothing here is Docker-specific: Xvfb is supplied by the image's entrypoint, so
the browser runs headful (real headless Chromium has its own fingerprint).
"""

import os
import sys

from antibrow import AntibrowError, launch

TARGET = os.environ.get("TARGET_URL", "https://example.com")


def main() -> int:
    try:
        with launch(
            profile=os.environ.get("ANTIBROW_PROFILE", "docker-01"),
            proxy=os.environ.get("ANTIBROW_PROXY"),
            on_progress=lambda m: print("[antibrow]", m, flush=True),
        ) as browser:
            print("kernel", browser.kernel_version, "| timezone", browser.timezone)
            page = browser.new_page()
            page.goto(TARGET, wait_until="domcontentloaded")
            print("title:", page.title())
            print("ua:   ", page.evaluate("navigator.userAgent"))
            print(page.inner_text("body")[:400])
        return 0
    except AntibrowError as exc:
        # The usual causes: ANTIBROW_API_KEY is not set in the container, or the
        # cache volume is missing so the kernel has to download on every run.
        print("antibrow error:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
