import pytest

from antibrow import browser as _browser


@pytest.fixture(autouse=True)
def _reset_local_only_notice():
    """The local-only notice fires once per profile name per process; tests
    across every file share that module-level state and must not leak it.
    """
    _browser._local_only_notified.clear()
    yield
    _browser._local_only_notified.clear()


@pytest.fixture(autouse=True)
def _no_telemetry(monkeypatch):
    """Launch tests must never report to the real API; telemetry tests opt back in."""
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "0")
