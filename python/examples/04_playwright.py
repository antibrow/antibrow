"""Playwright, unchanged.

The handle returned by launch() delegates to the Playwright BrowserContext, so
every selector, locator, wait, route and event you already use works. The only
line that changes when you move an existing script over is the launch itself.

    python examples/04_playwright.py
"""

from antibrow import launch, launch_persistent_context


def with_the_handle() -> None:
    """Normal usage: the handle behaves like a BrowserContext."""
    with launch(profile="demo-playwright") as browser:
        # Context-level APIs, straight through the handle.
        browser.set_default_timeout(15_000)
        browser.add_init_script("window.__antibrow = true")
        browser.route("**/*.{png,jpg,jpeg,webp}", lambda route: route.abort())  # skip images

        page = browser.new_page()
        page.on("console", lambda msg: print("[console]", msg.type, msg.text))
        page.goto("https://playwright.dev/python/")

        page.get_by_role("link", name="Get started").click()
        page.wait_for_url("**/docs/intro")
        print("heading:", page.get_by_role("heading", level=1).inner_text())
        print("init script visible to the page:", page.evaluate("window.__antibrow"))

        # Cookies and storage live in the profile directory and survive restarts.
        print("cookies:", len(browser.cookies()))

        page.screenshot(path="playwright-docs.png")


def with_a_raw_context() -> None:
    """When an API insists on a real playwright BrowserContext object."""
    context = launch_persistent_context(profile="demo-playwright-raw", headless=True)
    try:
        page = context.new_page()
        page.goto("https://example.com")
        print("raw context title:", page.title())
    finally:
        context.close()  # also stops the kernel


if __name__ == "__main__":
    with_the_handle()
    with_a_raw_context()
