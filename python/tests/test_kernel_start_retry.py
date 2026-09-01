"""A kernel that dies on the way up is retried; an explained failure is not."""

from __future__ import annotations

import pytest

from antibrow.errors import ConcurrencyLimitError
from antibrow.launcher import KernelStartupCrash, retry_kernel_start


def test_starts_again_after_a_kernel_that_died_before_cdp_was_ready():
    # Roughly one Linux start in twenty dies in fontconfig while Chromium paints
    # its own "unsupported command-line flag" bar - inside the kernel's statically
    # linked copy, so no host package or font set fixes it. A second attempt on
    # the same profile succeeds, and that is the whole remedy available to us.
    attempts = []

    def start():
        attempts.append(1)
        if len(attempts) < 2:
            raise KernelStartupCrash("Browser exited before the CDP endpoint was ready")
        return "ws://127.0.0.1:9222/devtools/browser/abc"

    assert retry_kernel_start(start, delay=0) == "ws://127.0.0.1:9222/devtools/browser/abc"
    assert len(attempts) == 2


def test_gives_up_after_three_attempts_and_reports_the_last_crash():
    attempts = []

    def start():
        attempts.append(1)
        raise KernelStartupCrash("crash {0}".format(len(attempts)))

    with pytest.raises(KernelStartupCrash, match="crash 3"):
        retry_kernel_start(start, delay=0)
    assert len(attempts) == 3


def test_does_not_retry_a_failure_the_kernel_already_explained():
    # A concurrency cap, a rejected license or a start that hung until the
    # timeout all fail the same way every time; retrying only makes the user
    # wait three times as long for the same message.
    attempts = []

    def start():
        attempts.append(1)
        raise ConcurrencyLimitError("Concurrency limit reached (1)")

    with pytest.raises(ConcurrencyLimitError):
        retry_kernel_start(start, delay=0)
    assert len(attempts) == 1
