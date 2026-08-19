"""Temporary profiles and the cloud-sync decision table.

The table is the whole point: a launch resolves whether to touch the cloud from
``temporary``, ``sync`` and the plan's license flag, and a default launch must
never create a server-side profile row - an automation run that mints a name per
task would otherwise fill the account's sync quota with profiles nobody asked to
keep.
"""

import pytest

from antibrow import browser as _browser
from antibrow.license import LicenseInfo
from antibrow.profile_dir import ResolvedProfile


@pytest.fixture(autouse=True)
def _restore_sync_module():
    """Undo the stub `_restore` installs - it patches the shared module object."""
    original = _browser._sync.ensure_server_profile
    yield
    _browser._sync.ensure_server_profile = original


def _license(sync: bool) -> LicenseInfo:
    return LicenseInfo(token="tok", exp=4102444800, mi=10, sync=sync)


def _restore(tmp_path, *, sync, temporary, license_sync=True, calls=None, exists=True, status=None, on_progress=None):
    def _ensure(api_key, server=None, *, name, tags=None, create=True, probe_status=None):
        if calls is not None:
            calls.append({"name": name, "create": create})
        if probe_status is not None:
            probe_status.append(status if status is not None else (200 if exists else 404))
        return exists or create

    _browser._sync.ensure_server_profile = _ensure  # type: ignore[attr-defined]
    return _browser._restore_archive(
        profile_name="acct",
        directory=tmp_path,
        api_key="adb_test",
        server="https://example.invalid",
        license_info=_license(license_sync),
        sync=sync,
        temporary=temporary,
        on_sync=None,
        notify=lambda _m: None,
        on_progress=on_progress,
    )


def test_temporary_with_sync_true_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="temporary"):
        _restore(tmp_path, sync=True, temporary=True)


def test_temporary_is_local_only(tmp_path):
    calls = []
    assert _restore(tmp_path, sync=None, temporary=True, calls=calls) is None
    assert calls == []


def test_default_never_creates_the_server_row(tmp_path):
    calls = []
    _restore(tmp_path, sync=None, temporary=False, calls=calls, exists=False)
    assert calls == [{"name": "acct", "create": False}]


# -- local-only notice -----------------------------------------------------
#
# A paid plan whose default launch mints a name the server has never seen
# now stays local-only rather than creating a row - so this is the one spot
# a caller relying on the old auto-create behaviour needs a nudge. Unlike
# every other message in this module it is not gated behind on_progress: a
# caller who wired nothing still gets it, on stdout - only a caller who did
# wire on_progress gets it routed there instead.


def test_prints_to_stdout_when_a_default_launch_finds_an_unknown_name_on_a_syncing_plan(tmp_path, capsys):
    _restore(tmp_path, sync=None, temporary=False, exists=False)

    out = capsys.readouterr().out
    assert "local-only" in out
    assert "acct" in out
    assert "sync=True" in out


def test_routes_to_on_progress_instead_of_stdout_when_the_caller_supplied_one(tmp_path, capsys):
    received = []
    _restore(tmp_path, sync=None, temporary=False, exists=False, on_progress=received.append)

    assert capsys.readouterr().out == ""  # not printed twice / to the wrong sink
    assert len(received) == 1
    assert "local-only" in received[0]


def test_stays_silent_when_sync_false_was_passed(tmp_path, capsys):
    assert _restore(tmp_path, sync=False, temporary=False) is None
    assert capsys.readouterr().out == ""


def test_stays_silent_for_a_temporary_profile(tmp_path, capsys):
    _restore(tmp_path, sync=None, temporary=True, exists=False)
    assert capsys.readouterr().out == ""


def test_stays_silent_on_a_plan_without_cloud_sync(tmp_path, capsys):
    _restore(tmp_path, sync=None, temporary=False, license_sync=False, exists=False)
    assert capsys.readouterr().out == ""


def test_stays_silent_when_the_profile_already_syncs(tmp_path, capsys):
    _restore(tmp_path, sync=None, temporary=False, exists=True)
    assert capsys.readouterr().out == ""


def test_warns_without_claiming_local_only_on_a_transient_probe_failure(tmp_path, capsys):
    # status=0: the request never got an answer, so this is not "the server
    # said no" - the very distinction a dropped connection must not erase. It
    # still has to be said out loud, though: silence is what let a whole
    # session run and be discarded.
    _restore(tmp_path, sync=None, temporary=False, exists=False, status=0)
    out = capsys.readouterr().out
    assert "local-only" not in out
    assert "without cloud sync" in out


def test_fires_only_once_across_repeated_launches_of_the_same_name(tmp_path, capsys):
    _restore(tmp_path, sync=None, temporary=False, exists=False)
    _restore(tmp_path, sync=None, temporary=False, exists=False)
    _restore(tmp_path, sync=None, temporary=False, exists=False)

    assert capsys.readouterr().out.count("local-only") == 1


def test_explicit_sync_creates_the_server_row(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        _browser._sync, "get_profile_archive_urls", lambda *a, **k: None
    )
    _restore(tmp_path, sync=True, temporary=False, calls=calls, exists=False)
    assert calls == [{"name": "acct", "create": True}]


def test_explicit_sync_on_a_plan_without_sync_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="plan"):
        _restore(tmp_path, sync=True, temporary=False, license_sync=False)


def test_prepare_launch_rejects_temporary_sync_before_any_io(tmp_path, monkeypatch):
    def fail_license(*a, **k):
        raise AssertionError("license must not be fetched for a rejected combination")

    monkeypatch.setattr(_browser, "get_license_token", fail_license)

    with pytest.raises(ValueError, match="temporary"):
        _browser.prepare_launch("task-1", cache_dir=tmp_path, temporary=True, sync=True)

    assert not (tmp_path / "profiles-temp").exists()
    assert not (tmp_path / "profiles").exists()


def test_prepare_launch_rejects_unsynced_plan_before_creating_the_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(_browser, "get_license_token", lambda *a, **k: _license(False))

    with pytest.raises(ValueError, match="plan"):
        _browser.prepare_launch("task-1", cache_dir=tmp_path, sync=True, license_token="tok")

    assert not (tmp_path / "profiles").exists()


class _StoppedAfterResolve(RuntimeError):
    """Marker raised by the test stub below - never raised by real code."""


def test_temporary_launch_uses_the_temporary_tree(tmp_path, monkeypatch):
    seen = {}

    def _resolve(name, cache_dir=None, api_key=None, server=None, *, temporary=False):
        seen["temporary"] = temporary
        directory = _browser._config.profiles_dir(cache_dir, temporary=temporary) / name
        directory.mkdir(parents=True, exist_ok=True)
        return ResolvedProfile(dir=directory, id=name, name=name)

    def _stop(*a, **k):
        raise _StoppedAfterResolve

    monkeypatch.setattr(_browser, "resolve_profile_dir", _resolve)
    monkeypatch.setattr(_browser, "get_license_token", lambda *a, **k: _license(True))
    # Everything past the resolver needs a real kernel download, which is
    # unavailable in some CI runs and slow-but-available in others - neither
    # is what this test is about. Stop right after the resolver runs instead,
    # with a marker type nothing else in the codebase raises, so the only
    # thing under test is that `temporary` reached it.
    monkeypatch.setattr(_browser._kernel, "refresh_kernel_versions", _stop)
    with pytest.raises(_StoppedAfterResolve):
        _browser.prepare_launch("task-1", cache_dir=tmp_path, temporary=True, license_token="tok")
    assert seen["temporary"] is True
