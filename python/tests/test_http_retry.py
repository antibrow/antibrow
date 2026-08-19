"""Throttling is the normal state of a parallel workload.

The account's rate limit is shared by every lane running under one API key, and
a single launch spends several ``/api/v1/`` calls, so N lanes starting together
arrive as one burst. Without retries each 429 became a hard failure - or, worse,
a silent "this profile has no cloud copy" that ran a whole session and discarded
it.
"""

from __future__ import annotations

import pytest

from antibrow import _http as H


@pytest.fixture(autouse=True)
def _no_real_sleeping(monkeypatch):
    slept = []
    monkeypatch.setattr(H.time, "sleep", slept.append)
    return slept


def _responder(monkeypatch, statuses, retry_after=None):
    """Make ``send`` see ``statuses`` in order; returns the attempt log."""
    seen = []

    def fake(method, url, **kwargs):
        seen.append(url)
        status = statuses[min(len(seen) - 1, len(statuses) - 1)]
        return status, "{}", retry_after

    monkeypatch.setattr(H, "_send_once", fake)
    return seen


def test_retry_delay_waits_out_the_named_window():
    assert 17.0 <= H.retry_delay(1, "17") < 17.0 + 5.0


def test_retry_delay_never_comes_back_early():
    # Jitter is added, never subtracted: returning before the window resets just
    # burns the attempt.
    assert all(H.retry_delay(1, "60") >= 60.0 for _ in range(50))


def test_retry_delay_backs_off_without_a_hint():
    assert H.retry_delay(1, None) < H.retry_delay(3, None)


def test_retry_delay_spreads_concurrent_callers():
    # Every lane on one key is handed the same Retry-After, so identical delays
    # would rebuild the burst that caused the 429.
    assert len({H.retry_delay(1, "5") for _ in range(40)}) > 1


def test_retries_a_429_and_returns_the_success(monkeypatch):
    seen = _responder(monkeypatch, [429, 200])
    assert H.send("GET", "https://s/x")[0] == 200
    assert len(seen) == 2


def test_retries_transport_failures(monkeypatch):
    seen = _responder(monkeypatch, [H.UNREACHABLE, 200])
    assert H.send("GET", "https://s/x")[0] == 200
    assert len(seen) == 2


def test_does_not_retry_a_settled_4xx(monkeypatch):
    seen = _responder(monkeypatch, [404])
    assert H.send("GET", "https://s/x")[0] == 404
    assert len(seen) == 1


def test_gives_up_bounded_and_hands_back_the_last_429(monkeypatch):
    seen = _responder(monkeypatch, [429])
    assert H.send("GET", "https://s/x")[0] == 429
    assert len(seen) == H.RETRY_MAX_ATTEMPTS


def test_stops_rather_than_sleeping_past_its_budget(monkeypatch, _no_real_sleeping):
    # A 429 naming a long window must not turn a launch into a ten-minute stall.
    seen = _responder(monkeypatch, [429], retry_after="600")
    assert H.send("GET", "https://s/x")[0] == 429
    assert len(seen) < H.RETRY_MAX_ATTEMPTS
    assert sum(_no_real_sleeping) <= H.RETRY_BUDGET_SECONDS
