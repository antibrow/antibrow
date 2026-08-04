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
from antibrow.errors import ProfileCacheError
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
    calls = {"ensure": [], "sign": []}

    def ensure(api_key, server=None, *, name, tags=None):
        calls["ensure"].append(name)
        return True

    def sign(api_key, server=None, *, name):
        calls["sign"].append(name)
        return ArchiveUrls(download_url="https://r2/get", upload_url="https://r2/put")

    monkeypatch.setattr(B._sync, "ensure_server_profile", ensure)
    monkeypatch.setattr(B._sync, "get_profile_archive_urls", sign)
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


def session_for(tmp_path, monkeypatch, plan, log):
    monkeypatch.setattr(B, "kill_process_tree", lambda process: log.append("killed"))
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
        return 1

    monkeypatch.setattr(B, "upload_profile_cache", upload)
    session = session_for(tmp_path, monkeypatch, plan, log)
    signed_at_launch = len(server_stub["sign"])

    session.close()

    assert log.index("killed") < log.index("uploaded")
    assert uploads == ["https://r2/put"]
    # Signed again at exit rather than reusing the launch-time signature.
    assert len(server_stub["sign"]) == signed_at_launch + 1
    assert session.sync_error is None


def test_an_expired_presign_is_signed_again_once(tmp_path, fake_kernel, paid_license, server_stub, monkeypatch):
    monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
    plan = plan_for(tmp_path)
    attempts = []

    def upload(profile_dir, url):
        attempts.append(url)
        if len(attempts) == 1:
            raise ProfileCacheError("Failed to upload profile cache: HTTP 403")
        return 1

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
    monkeypatch.setattr(B, "kill_process_tree", lambda process: log.append("killed"))

    class _AsyncStub(_Stub):
        async def close(self):
            self._log.append("closed-{0}".format(self._name))

        async def stop(self):
            self._log.append("stopped")

    stub = _AsyncStub(log, "browser")
    session = B.AsyncAntibrow(plan, stub, "ws://127.0.0.1:1/x", _AsyncStub(log, "pw"), stub, stub)

    asyncio.run(session.close())

    assert log.index("killed") < log.index("uploaded")
    assert session.sync_error is None
