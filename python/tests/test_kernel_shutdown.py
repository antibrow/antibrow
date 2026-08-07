"""shutdown_kernel: graceful close first, kill only if the browser will not exit."""

from __future__ import annotations

import threading
import time

from antibrow import launcher as L


class _FakeProcess:
    """Enough of subprocess.Popen for shutdown_kernel's poll loop and kill path."""

    def __init__(self):
        self._exited = False
        self.pid = 12345

    def poll(self):
        return 0 if self._exited else None

    def exit(self):
        self._exited = True


def test_lets_the_browser_exit_on_its_own_and_never_kills_it(monkeypatch):
    killed = []
    monkeypatch.setattr(L, "kill_process_tree", lambda process: killed.append(process))
    proc = _FakeProcess()

    def request_close():
        threading.Timer(0.02, proc.exit).start()

    outcome = L.shutdown_kernel(request_close, proc, grace=2.0, poll=0.005)

    assert outcome == "graceful"
    assert killed == []


def test_kills_once_the_grace_period_runs_out(monkeypatch):
    killed = []
    monkeypatch.setattr(L, "kill_process_tree", lambda process: killed.append(process))
    proc = _FakeProcess()

    outcome = L.shutdown_kernel(lambda: None, proc, grace=0.03, poll=0.005)

    assert outcome == "killed"
    assert killed == [proc]


def test_still_waits_when_the_close_request_itself_raises(monkeypatch):
    killed = []
    monkeypatch.setattr(L, "kill_process_tree", lambda process: killed.append(process))
    proc = _FakeProcess()

    def request_close():
        # Browser.close routinely fails as the connection drops with the browser.
        threading.Timer(0.02, proc.exit).start()
        raise RuntimeError("disconnected")

    outcome = L.shutdown_kernel(request_close, proc, grace=2.0, poll=0.005)

    assert outcome == "graceful"
    assert killed == []


def test_returns_and_kills_within_the_grace_period_when_request_close_never_settles(monkeypatch):
    killed = []
    monkeypatch.setattr(L, "kill_process_tree", lambda process: killed.append(process))
    proc = _FakeProcess()
    blocker = threading.Event()

    def request_close():
        # A browser wedged mid-shutdown can leave its CDP socket open with no
        # ack ever coming. The old code called request_close() inline before
        # starting the deadline, so this would hang the whole function forever.
        blocker.wait()

    start = time.time()
    outcome = L.shutdown_kernel(request_close, proc, grace=0.05, poll=0.005)
    elapsed = time.time() - start

    assert outcome == "killed"
    assert killed == [proc]
    assert elapsed < 1.0
