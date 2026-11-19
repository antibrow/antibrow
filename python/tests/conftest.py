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


@pytest.fixture(autouse=True)
def _server_offers_everything(request, monkeypatch):
    """Opt in with ``@pytest.mark.server_offers_everything`` (or a module-level
    ``pytestmark``): the test talks to a local stand-in server with no config route.
    """
    if request.node.get_closest_marker("server_offers_everything") is None:
        return
    from antibrow import server_config

    monkeypatch.setattr(
        server_config,
        "effective_server_config",
        lambda *a, **k: {
            "features": {"managedProxy": True, "liveView": True, "realDevices": True},
            "recipeRegistryUrl": "x",
        },
    )
