"""Cloud sync inside a launch: restore before the persona, upload after exit.

The two orderings asserted here are the whole correctness story of sync:

* the archive is restored *before* the persona is read, because persona.json is
  itself part of the archive;
* the upload happens *after* the kernel process is gone, and the presigned URL
  is signed at that moment - a signature only lives 900 seconds, far less than a
  browsing session.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from antibrow import browser as B
from antibrow import kernel as K
from antibrow import license as L
from antibrow import profile_cache as P
from antibrow.errors import AntibrowError, ProfileCacheError
from antibrow.profile_sync import ArchiveUrls


@pytest.fixture
def fake_kernel(tmp_path, monkeypatch):
    exe_name = "chrome.exe" if K.current_platform() == "win32" else "chrome"

    def ensure(cache_dir, kv=None, on_progress=None, **kwargs):
        version = (kv or K.default_kernel_version()).version
        path = K.kernel_dir(cache_dir, version) / exe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        return path

    monkeypatch.setattr(B._kernel, "ensure_kernel", ensure)
    monkeypatch.setattr(B._kernel, "refresh_kernel_versions", lambda *a, **k: False)
    return exe_name


@pytest.fixture
def paid_license(monkeypatch):
    """A token whose plan includes cloud sync, plus a resolvable API key."""
    info = L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=5, sync=True)
    monkeypatch.setattr(B, "get_license_token", lambda *a, **k: info)
    monkeypatch.setenv("ANTIBROW_API_KEY", "adb_test_key")
    return info


@pytest.fixture
def free_license(monkeypatch):
    info = L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=1, sync=False)
    monkeypatch.setattr(B, "get_license_token", lambda *a, **k: info)
    monkeypatch.setenv("ANTIBROW_API_KEY", "adb_test_key")
    return info


@pytest.fixture
def server_stub(monkeypatch):
    """Record archive calls and hand out presigned URLs."""
    calls = {"ensure": [], "sign": [], "sign_upload": []}

    # `create` is False on a default launch: a launch only looks the profile up,
    # it never spends a cloud-sync slot on a name nobody asked to keep.
    def ensure(api_key, server=None, *, name, tags=None, create=True, probe_status=None):
        calls["ensure"].append(name)
        if probe_status is not None:
            probe_status.append(200)
        return True

    def sign(api_key, server=None, *, name):
        calls["sign"].append(name)
        return ArchiveUrls(download_url="https://r2/get", upload_url="https://r2/put")

    def sign_upload(api_key, server=None, *, name):
        calls["sign_upload"].append(name)
        return "https://r2/put"

    monkeypatch.setattr(B._sync, "ensure_server_profile", ensure)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", sign)
    monkeypatch.setattr(B._sync, "get_profile_archive_upload_url", sign_upload)
    return calls


def plan_for(tmp_path, **kwargs):
    options = {"cache_dir": tmp_path, "geoip": False, "profile": "p1"}
    options.update(kwargs)
    return B.prepare_launch(**options)


# -- restore --------------------------------------------------------------


def test_the_restored_persona_is_the_one_the_launch_uses(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    # Restoring after loading the persona would silently give this profile a new
    # identity on every machine, so prove the archive lands first.
    restored = {
        "seed": "restored-seed",
        "canvasSeed": "cs",
        "audioSeed": "as",
        "domrectSeed": "ds",
        "chromeMajor": 150,
        "kernelVersion": K.default_kernel_version().version,
        "ua": "Mozilla/5.0 restored",
        "platform": "Win32",
        "hardwareConcurrency": 8,
        "deviceMemory": 8,
        "screenW": 1920,
        "screenH": 1080,
        "devicePixelRatio": 1,
        "gpuVendor": "Google Inc. (NVIDIA)",
        "gpuRenderer": "ANGLE (NVIDIA)",
        "languages": ["en-US", "en"],
        "timezone": "America/New_York",
    }

    def download(url, profile_dir):
        assert url == "https://r2/get"
        (profile_dir / "persona.json").write_text(json.dumps(restored))
        return True

    monkeypatch.setattr(B, "download_profile_cache", download)

    plan = plan_for(tmp_path)

    assert plan.persona.seed == "restored-seed"
    assert plan.archive is not None and plan.archive.restored is True
    assert server_stub["ensure"] == ["p1"]


def test_a_free_plan_stays_entirely_local(tmp_path, fake_kernel, free_license, monkeypatch):
    monkeypatch.setattr(
        B._sync, "get_profile_archive_urls", lambda *a, **k: pytest.fail("no sync on a free plan")
    )
    monkeypatch.setattr(
        B, "download_profile_cache", lambda *a, **k: pytest.fail("no sync on a free plan")
    )

    plan = plan_for(tmp_path)

    assert plan.archive is None


def test_sync_false_opts_out_even_on_a_paid_plan(tmp_path, fake_kernel, paid_license, monkeypatch):
    monkeypatch.setattr(
        B._sync, "get_profile_archive_urls", lambda *a, **k: pytest.fail("sync was turned off")
    )

    assert plan_for(tmp_path, sync=False).archive is None


def test_a_first_launch_with_no_archive_yet_still_gets_an_upload_slot(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)

    plan = plan_for(tmp_path)

    assert plan.archive is not None
    assert plan.archive.restored is False
    assert plan.archive.can_upload is True


def test_a_failed_restore_does_not_break_the_launch(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    def boom(url, profile_dir):
        raise ProfileCacheError("Failed to download profile cache: HTTP 500")

    monkeypatch.setattr(B, "download_profile_cache", boom)
    events = []

    plan = plan_for(tmp_path, on_sync=events.append)

    assert plan.persona is not None
    assert [(e.phase, e.state) for e in events] == [("download", "start"), ("download", "error")]
    assert "HTTP 500" in events[-1].error


# -- local-only notice, through the real launch path ----------------------
#
# `_restore_archive` is exercised directly (and more exhaustively) in
# test_launch_temporary.py; these two go through `prepare_launch` itself to
# pin the one thing that matters for a bare `launch("name")` call: the
# notice must reach the user even though nothing else in this function does
# without an explicit `on_progress`.


def _unknown_name(monkeypatch) -> None:
    def ensure(api_key, server=None, *, name, tags=None, create=True, probe_status=None):
        if probe_status is not None:
            probe_status.append(404)
        return False

    monkeypatch.setattr(B._sync, "ensure_server_profile", ensure)


def test_a_bare_launch_prints_the_local_only_notice_to_stdout(tmp_path, fake_kernel, paid_license, monkeypatch, capsys):
    _unknown_name(monkeypatch)

    plan = plan_for(tmp_path)

    assert plan.archive is None
    out = capsys.readouterr().out
    assert "local-only" in out
    assert "sync=True" in out


def test_an_on_progress_caller_gets_it_there_instead_of_stdout(tmp_path, fake_kernel, paid_license, monkeypatch, capsys):
    _unknown_name(monkeypatch)
    messages = []

    plan = plan_for(tmp_path, on_progress=messages.append)

    assert plan.archive is None
    assert capsys.readouterr().out == ""
    assert any("local-only" in m for m in messages)


# -- the server could not answer ------------------------------------------

# A throttled or unreachable server used to be indistinguishable from "this
# profile does not exist in the cloud": the launch went ahead local-only, so the
# session neither restored nor uploaded and the data was quietly lost.


def _unreachable(monkeypatch, status: int) -> None:
    def ensure(api_key, server=None, *, name, tags=None, create=True, probe_status=None):
        if probe_status is not None:
            probe_status.append(status)
        return False

    monkeypatch.setattr(B._sync, "ensure_server_profile", ensure)


def test_a_throttled_probe_warns_instead_of_launching_unsynced_in_silence(
    tmp_path, fake_kernel, paid_license, monkeypatch
):
    _unreachable(monkeypatch, 429)
    messages = []

    plan = plan_for(tmp_path, on_progress=messages.append)

    assert plan.archive is None
    assert any("without cloud sync" in m for m in messages)


def test_an_explicit_sync_request_fails_rather_than_running_unsynced(
    tmp_path, fake_kernel, paid_license, monkeypatch
):
    # `sync=True` is a promise about where the data goes. Handing back a browser
    # that silently uploads nothing is worse than not launching.
    _unreachable(monkeypatch, 429)

    with pytest.raises(AntibrowError, match="429"):
        plan_for(tmp_path, sync=True)


# -- upload on close ------------------------------------------------------


class _Stub:
    """Stands in for the Playwright objects a session closes."""

    def __init__(self, log, name):
        self._log = log
        self._name = name
        self.pages = []
        self.pid = 4242

    def close(self):
        self._log.append("closed-{0}".format(self._name))

    def stop(self):
        self._log.append("stopped")


def _fake_shutdown(log):
    """Stand in for the graceful shutdown: record that the kernel is gone.

    Closing asks the browser to quit and waits for the process, so the upload
    still has to come after - packing a profile the kernel is mid-write in is
    how a synced profile loses cookies and tabs.
    """

    def shutdown(request_close, process, **_kwargs):
        try:
            request_close()
        except Exception:
            pass
        log.append("kernel-gone")
        return "graceful"

    return shutdown


def session_for(tmp_path, monkeypatch, plan, log):
    monkeypatch.setattr(B, "shutdown_kernel", _fake_shutdown(log))
    stub = _Stub(log, "browser")
    return B.Antibrow(plan, stub, "ws://127.0.0.1:1/x", _Stub(log, "pw"), stub, stub)


def test_upload_runs_after_the_kernel_is_gone_with_a_freshly_signed_url(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    log = []
    uploads = []

    def upload(profile_dir, url):
        log.append("uploaded")
        uploads.append(url)
        return "etag-1"

    monkeypatch.setattr(B, "upload_profile_cache", upload)
    session = session_for(tmp_path, monkeypatch, plan, log)
    signed_at_launch = len(server_stub["sign"])

    session.close()

    assert log.index("kernel-gone") < log.index("uploaded")
    assert uploads == ["https://r2/put"]
    # Signed again at exit rather than reusing the launch-time signature - and
    # through the upload-only route, which spares the server a HEAD on an object
    # this upload is about to replace.
    assert server_stub["sign_upload"] == ["p1"]
    assert len(server_stub["sign"]) == signed_at_launch
    assert session.sync_error is None


def test_an_expired_presign_is_signed_again_once(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    attempts = []

    def upload(profile_dir, url):
        attempts.append(url)
        if len(attempts) == 1:
            raise ProfileCacheError("Failed to upload profile cache: HTTP 403")
        return "etag-2"

    monkeypatch.setattr(B, "upload_profile_cache", upload)
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()

    assert len(attempts) == 2
    assert session.sync_error is None


def test_a_failed_upload_is_reported_but_never_raised(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    events = []
    plan = plan_for(tmp_path, on_sync=events.append)

    def upload(profile_dir, url):
        raise ProfileCacheError("Failed to upload profile cache: HTTP 500")

    monkeypatch.setattr(B, "upload_profile_cache", upload)
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()  # must not raise

    assert "HTTP 500" in session.sync_error
    assert ("upload", "error") in [(e.phase, e.state) for e in events]


def test_closing_twice_uploads_once(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    attempts = []
    monkeypatch.setattr(B, "upload_profile_cache", lambda d, u: attempts.append(u))
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()
    session.close()

    assert len(attempts) == 1


def test_a_local_session_uploads_nothing(tmp_path, fake_kernel, free_license, monkeypatch):
    plan = plan_for(tmp_path)
    monkeypatch.setattr(
        B, "upload_profile_cache", lambda *a, **k: pytest.fail("nothing to upload")
    )
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()

    assert session.sync_error is None


def test_the_async_session_uploads_on_close_too(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    log = []
    monkeypatch.setattr(B, "upload_profile_cache", lambda d, u: log.append("uploaded"))
    monkeypatch.setattr(B, "shutdown_kernel", _fake_shutdown(log))

    class _AsyncStub(_Stub):
        async def close(self):
            self._log.append("closed-{0}".format(self._name))

        async def stop(self):
            self._log.append("stopped")

    stub = _AsyncStub(log, "browser")
    session = B.AsyncAntibrow(plan, stub, "ws://127.0.0.1:1/x", _AsyncStub(log, "pw"), stub, stub)

    asyncio.run(session.close())

    assert log.index("kernel-gone") < log.index("uploaded")
    assert session.sync_error is None


# -- archive generation gate ----------------------------------------------
#
# Equality only - an ETag has no ordering. The case that matters: the last
# upload failed, so the cloud still holds the generation this machine
# already has, and restoring it would erase newer local work that never
# made it up.


def _archive_urls(version=None):
    return lambda *a, **k: ArchiveUrls(download_url="https://r2/get", upload_url="https://r2/put", version=version)


def test_downloads_when_this_machine_has_no_marker_yet(tmp_path, fake_kernel, paid_license, monkeypatch):
    downloaded = []
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: downloaded.append(url) or True)
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", _archive_urls("etag-1"))

    plan = plan_for(tmp_path)

    assert downloaded == ["https://r2/get"]
    assert P.read_archive_version(plan.profile_dir) == "etag-1"


def test_skips_the_download_entirely_when_the_marker_already_matches(tmp_path, fake_kernel, paid_license, monkeypatch):
    directory = B._config.profile_dir("p1", tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    P.write_archive_version(directory, "etag-1")
    events = []
    monkeypatch.setattr(B, "download_profile_cache", lambda *a, **k: pytest.fail("must not download"))
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", _archive_urls("etag-1"))

    plan = plan_for(tmp_path, on_sync=events.append)

    assert events == []  # no download-phase event fires when nothing is transferred
    assert P.read_archive_version(plan.profile_dir) == "etag-1"


def test_downloads_when_the_marker_names_a_different_generation(tmp_path, fake_kernel, paid_license, monkeypatch):
    directory = B._config.profile_dir("p1", tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    P.write_archive_version(directory, "etag-old")
    downloaded = []
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: downloaded.append(url) or True)
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", _archive_urls("etag-new"))

    plan = plan_for(tmp_path)

    assert downloaded == ["https://r2/get"]
    assert P.read_archive_version(plan.profile_dir) == "etag-new"


def test_downloads_when_the_server_reported_no_version_at_all(tmp_path, fake_kernel, paid_license, monkeypatch):
    # An older server predates archive generations; the client must keep
    # restoring unconditionally rather than treating the missing field as an error.
    directory = B._config.profile_dir("p1", tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    P.write_archive_version(directory, "etag-old")
    downloaded = []
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: downloaded.append(url) or True)
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", _archive_urls(None))

    plan = plan_for(tmp_path)

    assert downloaded == ["https://r2/get"]
    # No reported version means nothing to record; the stale marker is left as-is.
    assert P.read_archive_version(plan.profile_dir) == "etag-old"


def test_a_failed_download_leaves_the_marker_untouched(tmp_path, fake_kernel, paid_license, monkeypatch):
    directory = B._config.profile_dir("p1", tmp_path)
    directory.mkdir(parents=True, exist_ok=True)
    P.write_archive_version(directory, "etag-old")

    def boom(url, profile_dir):
        raise ProfileCacheError("Failed to download profile cache: HTTP 500")

    monkeypatch.setattr(B, "download_profile_cache", boom)
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", _archive_urls("etag-new"))

    plan = plan_for(tmp_path)

    # A restore that never happened must not be recorded as having happened.
    assert P.read_archive_version(plan.profile_dir) == "etag-old"


def test_records_the_generation_it_just_uploaded(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    monkeypatch.setattr(B, "upload_profile_cache", lambda d, u: "etag-9")
    plan = plan_for(tmp_path)
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()

    assert P.read_archive_version(plan.profile_dir) == "etag-9"


def test_drops_the_marker_when_the_upload_response_named_no_generation(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    P.write_archive_version(plan.profile_dir, "etag-old")
    monkeypatch.setattr(B, "upload_profile_cache", lambda d, u: None)
    session = session_for(tmp_path, monkeypatch, plan, [])

    session.close()

    assert P.read_archive_version(plan.profile_dir) is None


# -- the close request has to reach the browser ---------------------------
#
# Playwright's sync API is greenlet-bound: touching it from a thread other than
# the one that created it raises instead of doing anything. A close that hands
# the CDP call to a worker thread therefore never asks the browser to quit - it
# waits out the whole grace period and SIGKILLs instead, and a SIGKILLed browser
# flushes nothing, which is exactly what the upload then packs up.


class _ThreadBoundBrowser:
    """A browser that only answers on the thread that created it."""

    def __init__(self, process):
        self._owner = __import__("threading").current_thread()
        self._process = process
        self.close_requested = False
        self.wrong_thread = False

    def _check(self):
        if __import__("threading").current_thread() is not self._owner:
            self.wrong_thread = True
            raise RuntimeError("cannot switch to a different thread")

    def new_browser_cdp_session(self):
        self._check()
        return self

    def send(self, method):
        self._check()
        if method == "Browser.close":
            self.close_requested = True
            self._process.exit()   # a real browser exits when asked

    def close(self):
        pass


class _ExitingProcess:
    def __init__(self):
        self._exited = False
        self.pid = 4242

    def poll(self):
        return 0 if self._exited else None

    def exit(self):
        self._exited = True


def test_close_asks_the_browser_to_quit_from_the_calling_thread(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    monkeypatch.setattr(B, "upload_profile_cache", lambda profile_dir, url: None)
    killed = []
    from antibrow import launcher as _L
    monkeypatch.setattr(_L, "kill_process_tree", lambda process: killed.append(process))

    plan = plan_for(tmp_path)
    proc = _ExitingProcess()
    browser = _ThreadBoundBrowser(proc)
    context = _Stub([], "ctx")
    session = B.Antibrow(plan, proc, "ws://127.0.0.1:1/x", _Stub([], "pw"), browser, context)

    session.close()

    assert browser.close_requested, "Browser.close never reached the browser"
    assert not browser.wrong_thread, "the CDP call was made from the wrong thread"
    assert killed == [], "the browser was killed instead of being asked to quit"
