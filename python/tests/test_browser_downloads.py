import asyncio

from antibrow.browser import (
    _cdp_connect_options,
    _restore_browser_downloads,
    _restore_browser_downloads_async,
)


class _NewType:
    def connect_over_cdp(self, endpoint_url, *, timeout=None, no_defaults=None):
        pass


class _OldType:
    def connect_over_cdp(self, endpoint_url, *, timeout=None):
        pass


def test_no_defaults_only_when_driver_supports_it():
    assert _cdp_connect_options(_NewType(), False) == {"no_defaults": True}
    assert _cdp_connect_options(_OldType(), False) == {}
    assert _cdp_connect_options(_NewType(), True) == {}


class _Cdp:
    def __init__(self, sent):
        self.sent = sent

    def send(self, method, params):
        self.sent.append((method, params))


def test_restore_downloads_sync_and_async():
    sent = []

    class Browser:
        def new_browser_cdp_session(self):
            return _Cdp(sent)

    _restore_browser_downloads(Browser())

    class AsyncCdp:
        async def send(self, method, params):
            sent.append((method, params))

    class AsyncBrowser:
        async def new_browser_cdp_session(self):
            return AsyncCdp()

    asyncio.run(_restore_browser_downloads_async(AsyncBrowser()))
    assert sent == [("Browser.setDownloadBehavior", {"behavior": "default"})] * 2
