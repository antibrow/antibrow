"""Every SDK HTTP call has to shrink to fit what is left of the launch budget.

Threading a timeout through license/api/profile_sync by hand would mean six
signatures and one of them always gets missed; the shared sender is the seam.
"""

from __future__ import annotations

import pytest

from antibrow import _http
from antibrow.deadline import Deadline


@pytest.fixture
def recorded(monkeypatch):
    """Capture the socket timeout `send` asks urllib for."""
    seen = []

    class Response:
        status = 200

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(request, timeout=None):
        seen.append(timeout)
        return Response()

    monkeypatch.setattr(_http.urllib.request, "urlopen", urlopen)
    return seen


def test_without_a_launch_budget_the_call_keeps_its_own_timeout(recorded):
    _http.send("GET", "https://example.com/x")

    assert recorded == [_http.DEFAULT_TIMEOUT]


def test_a_tight_budget_shortens_the_call(recorded):
    with Deadline(120.0, clock=iter([0.0, 117.5, 117.5]).__next__).active():
        _http.send("GET", "https://example.com/x")

    assert recorded[0] == pytest.approx(2.5)


def test_a_roomy_budget_leaves_the_call_alone(recorded):
    with Deadline(600.0, clock=iter([0.0, 1.0, 1.0]).__next__).active():
        _http.send("GET", "https://example.com/x")

    assert recorded[0] == _http.DEFAULT_TIMEOUT


def test_the_budget_is_dropped_again_on_the_way_out(recorded):
    with Deadline(120.0, clock=iter([0.0, 119.0, 119.0]).__next__).active():
        pass
    _http.send("GET", "https://example.com/x")

    assert recorded == [_http.DEFAULT_TIMEOUT]


def test_an_exhausted_budget_does_not_hand_urllib_a_zero_timeout(recorded):
    """timeout=0 is a non-blocking socket, which is not what "give up" means."""
    with Deadline(120.0, clock=iter([0.0] + [200.0] * 5).__next__).active():
        status, _text = _http.send("GET", "https://example.com/x")

    assert recorded == []
    assert status == _http.UNREACHABLE
