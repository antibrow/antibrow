"""crawl4ai through a fingerprinted browser.

crawl4ai can attach to an existing browser with BrowserConfig(cdp_url=...), so
antibrow supplies the browser and crawl4ai does the extraction. You keep
crawl4ai's markdown pipeline; the pages are fetched by a real Chromium with a
coherent fingerprint and (optionally) a residential exit.

    pip install antibrow crawl4ai
    python examples/07_crawl4ai.py
"""

import asyncio
import os

from antibrow import launch_async

URLS = [
    "https://example.com",
    "https://news.ycombinator.com",
]


async def main() -> None:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    session = await launch_async(
        profile="crawler-01",
        proxy=os.environ.get("ANTIBROW_PROXY"),
        headless=False,   # on Linux run the whole script under xvfb-run
    )
    print("driving", session.cdp_url, "| timezone", session.timezone)

    # cdp_url makes crawl4ai attach instead of launching its own Chromium.
    browser_config = BrowserConfig(cdp_url=session.cdp_url, headless=False, verbose=False)
    run_config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=30_000)

    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            for url in URLS:
                result = await crawler.arun(url=url, config=run_config)
                if not result.success:
                    print("FAILED", url, result.error_message)
                    continue
                markdown = str(result.markdown)
                print("\n===", url, "===")
                print(markdown[:500].strip())
                print("... ({0} chars, {1} links)".format(
                    len(markdown), len(result.links.get("internal", []))
                ))
    finally:
        await session.close()


if __name__ == "__main__":
    asyncio.run(main())
