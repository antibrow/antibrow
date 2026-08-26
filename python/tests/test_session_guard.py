"""A live session has to be reachable both by the exit hooks and by the reaper.

Registration happens in `_BaseSession`, so the sync and async handles cannot
drift apart on it.
"""

from __future__ import annotations

import json

import pytest

from antibrow import browser as B
from antibrow import reaper as R
from antibrow.exit_hooks import ExitHooks


class FakeProcess:
    def __init__(self, pid=4242):
        self.pid = pid

    def poll(self):
        return None


@pytest.fixture
def plan(tmp_path):
    persona = B.load_or_generate_persona(tmp_path / "p", "152")
    return B.LaunchPlan(
        exe_path=tmp_path / "chrome",
        args=[],
        cdp_port=51234,
        profile_dir=tmp_path / "p",
        user_data_dir=tmp_path / "p" / "user-data",
        persona=persona,
        timezone="UTC",
        label="demo",
        kernel_version="152",
        license=B.LicenseInfo(token="T.S", exp=2**31, mi=5, sync=False),
        cache_dir=tmp_path,
    )


@pytest.fixture
def hooks(monkeypatch):
    """A private hook set, so one test cannot close another test's session."""
    fresh = ExitHooks()
    monkeypatch.setattr(B._exit_hooks, "_hooks", fresh)
    return fresh


def test_a_new_session_is_recorded_for_the_next_run_to_reap(plan, hooks, tmp_path):
    B._BaseSession(plan, FakeProcess(), "ws://x")

    rows = json.loads(R.registry_path(tmp_path).read_text())
    assert [r["kernelPid"] for r in rows] == [4242]
    assert rows[0]["profileDir"] == str(tmp_path / "p")


def test_closing_a_session_takes_its_row_back_out(plan, hooks, tmp_path):
    session = B._BaseSession(plan, FakeProcess(), "ws://x")

    session._release_guard()

    assert json.loads(R.registry_path(tmp_path).read_text()) == []


def test_the_exit_hooks_can_close_a_session_that_is_still_open(plan, hooks):
    session = B._BaseSession(plan, FakeProcess(), "ws://x")
    closed = []
    session.close = lambda: closed.append(1)

    hooks.run()

    assert closed == [1]


def test_a_closed_session_is_not_closed_again_at_exit(plan, hooks):
    session = B._BaseSession(plan, FakeProcess(), "ws://x")
    closed = []
    session.close = lambda: closed.append(1)
    session._release_guard()

    hooks.run()

    assert closed == []


def test_a_detached_session_is_left_for_its_owner_to_manage(plan, hooks, tmp_path):
    """MCP keeps kernels alive across calls on purpose; killing them is the bug."""
    session = B._BaseSession(plan, FakeProcess(), "ws://x", detached=True)
    closed = []
    session.close = lambda: closed.append(1)

    hooks.run()

    assert closed == []
    assert not R.registry_path(tmp_path).exists()


def test_close_releases_the_guard_on_the_sync_handle(plan, hooks, tmp_path, monkeypatch):
    monkeypatch.setattr(B, "shutdown_kernel", lambda *a, **k: "graceful")
    monkeypatch.setattr(B, "_revoke_ticket", lambda *a: None)

    class Dead:
        def __getattr__(self, name):
            raise RuntimeError("browser already gone")

    session = B.Antibrow.__new__(B.Antibrow)
    B._BaseSession.__init__(session, plan, FakeProcess(), "ws://x")
    session._playwright = Dead()
    session.browser = Dead()
    session.context = Dead()
    session._initial_page = None
    session._initial_page_available = False

    session.close()

    assert json.loads(R.registry_path(tmp_path).read_text()) == []
    assert session._exit_token is None


def test_launch_sweeps_up_what_the_last_run_leaked(tmp_path, monkeypatch):
    """Whatever SIGKILL left behind dies at the start of the next launch."""
    swept = []
    monkeypatch.setattr(B._reaper, "reap_orphans", lambda cache_dir, **k: swept.append(cache_dir))
    monkeypatch.setattr(
        B, "prepare_launch", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("stop"))
    )

    with pytest.raises(RuntimeError):
        B.launch("demo", cache_dir=tmp_path)

    assert swept == [tmp_path]
