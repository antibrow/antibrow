"""What the SDK does about tabs at startup, on macOS.

macOS needs the ``-AppleLanguages (xx-XX)`` pair for Intl.*, and Chromium's own
parser takes the bare ``(xx-XX)`` for a URL. The kernel is therefore started with
no startup window at all - so the SDK owes the caller the first page, and still
keeps the old close-the-stray-tab guard for kernels that open one anyway.
"""

from __future__ import annotations

import asyncio

from antibrow import browser as B


class _Page:
    def __init__(self, url="about:blank"):
        self.url = url
        self.closed = False

    def close(self):
        self.closed = True

    def is_closed(self):
        return self.closed


class _Context:
    def __init__(self, pages=()):
        self.pages = list(pages)
        self.opened = 0

    def new_page(self):
        self.opened += 1
        page = _Page()
        self.pages.append(page)
        return page


class _AsyncContext(_Context):
    async def new_page(self):
        return _Context.new_page(self)


def test_the_sdk_opens_the_first_page_when_the_kernel_opened_none():
    context = _Context()

    B._ensure_startup_page(context)

    assert context.opened == 1
    assert [p.url for p in context.pages] == ["about:blank"]


def test_a_page_the_kernel_already_opened_is_left_alone():
    context = _Context([_Page("https://example.com/")])

    B._ensure_startup_page(context)

    assert context.opened == 0


def test_the_async_twin_opens_the_first_page_too():
    context = _AsyncContext()

    asyncio.run(B._ensure_startup_page_async(context))

    assert context.opened == 1


def test_that_page_is_the_one_the_first_new_page_call_reuses():
    # Same contract as Windows/Linux, where the kernel provides the blank tab:
    # the first new_page() hands it back instead of opening a second window.
    context = _Context()
    B._ensure_startup_page(context)
    session = B.Antibrow(_plan(), _Proc(), "ws://127.0.0.1:1/x", _Noop(), _Noop(), context)

    first = session.new_page()

    assert first is context.pages[0]
    assert context.opened == 1


class _Noop:
    def close(self):
        pass

    def stop(self):
        pass


class _Proc:
    pid = 1


def _plan():
    return B.LaunchPlan(
        exe_path="chrome",
        args=[],
        cdp_port=1,
        profile_dir="/tmp/p",
        user_data_dir="/tmp/p/user-data",
        persona=None,
        timezone="UTC",
        label="p",
        kernel_version="150.0.7871.182",
        license=None,
    )
