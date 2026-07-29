"""Scrapling's adaptive parsing on top of an antibrow session.

Scrapling's DynamicFetcher takes a cdp_url and connects to a running browser
instead of starting its own, so you get Scrapling's selectors and auto-matching
with antibrow's fingerprint and profile.

    pip install antibrow scrapling
    python examples/08_scrapling.py
"""

from antibrow import launch


def main() -> None:
    from scrapling.fetchers import DynamicFetcher

    browser = launch(profile="scrapling-01")
    print("cdp:", browser.cdp_endpoint)

    try:
        page = DynamicFetcher.fetch(
            "https://quotes.toscrape.com/",
            cdp_url=browser.cdp_endpoint,   # ws:// endpoint
            network_idle=True,
        )
        print("status:", page.status)

        for quote in page.css(".quote")[:5]:
            text = quote.css_first(".text::text")
            author = quote.css_first(".author::text")
            print("-", str(text).strip()[:70], "--", author)

        # Scrapling's adaptive selectors survive markup changes; combine them
        # with a persistent antibrow profile and the session survives too.
        first = page.css_first(".quote .text::text", auto_save=True)
        print("\nfirst quote:", str(first).strip()[:80])
    finally:
        browser.close()


if __name__ == "__main__":
    main()
