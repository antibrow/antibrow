"""Concurrent kernel installs must serialise instead of shredding each other."""

from __future__ import annotations

import http.server
import os
import threading
import time
import zipfile

import pytest

from antibrow import kernel as K
from antibrow.errors import KernelDownloadError

PLAT = "linux"  # portable path: darwin would need ditto and a signed bundle


@pytest.fixture
def counting_server(tmp_path):
    """Serve one kernel zip, slowly, and count the requests for it."""
    body = tmp_path / "kernel.zip"
    with zipfile.ZipFile(body, "w") as archive:
        archive.writestr("chrome", "#!/bin/sh\necho fake kernel\n")
    payload = body.read_bytes()
    hits = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib naming
            hits.append(self.path.split("?")[0])
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            # Dribbled out so a second caller is still queued while this runs.
            self.wfile.write(payload[:8])
            self.wfile.flush()
            time.sleep(0.2)
            self.wfile.write(payload[8:])

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:{0}".format(server.server_address[1]), hits
    finally:
        server.shutdown()
        server.server_close()


def make_version(base, version="0.0.0-lock", build="b1"):
    return K.KernelVersion(
        version, "Test kernel", {PLAT: K.KernelAsset(base + "/kernel.zip", "chrome", build=build)}
    )


def test_concurrent_installs_share_one_download(tmp_path, counting_server):
    base, hits = counting_server
    kv = make_version(base)
    cache = tmp_path / "cache"
    results: list = []

    def install():
        try:
            results.append(K.ensure_kernel(cache, kv, platform=PLAT))
        except BaseException as exc:  # surfaced by the assertion below
            results.append(exc)

    threads = [threading.Thread(target=install) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)

    assert len(results) == 2
    assert results[0] == results[1], results
    assert results[0].exists()
    assert len(hits) == 1, hits
    assert not K.kernel_lock_path(cache, kv.version, PLAT).exists()


def test_stale_lock_is_taken_over(tmp_path, counting_server):
    base, _ = counting_server
    kv = make_version(base, version="0.0.0-stale")
    cache = tmp_path / "cache"
    lock_path = K.kernel_lock_path(cache, kv.version, PLAT)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("999999\n")
    # An owner that died mid-install stops touching it.
    old = time.time() - 5 * 60
    os.utime(lock_path, (old, old))

    exe_path = K.ensure_kernel(cache, kv, platform=PLAT)

    assert exe_path.exists()
    assert not lock_path.exists()


def _holder(lock_path, exe_path, delay=0.4):
    """Stand in for another process finishing an install and releasing the lock."""
    done = {}

    def finish():
        time.sleep(delay)
        exe_path.write_text("fake kernel")
        done["at"] = time.monotonic()
        lock_path.unlink()

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("1\n")
    thread = threading.Thread(target=finish, daemon=True)
    thread.start()
    return thread, done


def test_waits_for_the_holder_before_adopting_its_install(tmp_path, counting_server):
    # The executable appears mid-extraction, so a waiter that trusted the exe
    # alone would hand out a half-unpacked kernel.
    base, hits = counting_server
    kv = make_version(base, version="0.0.0-adopt")
    cache = tmp_path / "cache"
    exe_path = K.kernel_dir(cache, kv.version) / "chrome"
    exe_path.parent.mkdir(parents=True, exist_ok=True)
    exe_path.write_text("half a kernel")
    K.write_installed_kernel_build(cache, kv.version, "b1")
    thread, done = _holder(K.kernel_lock_path(cache, kv.version, PLAT), exe_path)

    got = K.ensure_kernel(cache, kv, platform=PLAT, force=True)
    returned_at = time.monotonic()
    thread.join(5)

    assert got == exe_path
    assert "at" in done and returned_at >= done["at"]
    assert got.read_text() == "fake kernel"
    assert hits == []  # the holder's build was the one this call wanted


def test_does_not_launch_from_a_kernel_being_re_extracted(tmp_path, counting_server):
    base, hits = counting_server
    kv = make_version(base, version="0.0.0-inflight")
    cache = tmp_path / "cache"
    exe_path = K.kernel_dir(cache, kv.version) / "chrome"
    exe_path.parent.mkdir(parents=True, exist_ok=True)
    exe_path.write_text("about to be deleted")
    thread, _ = _holder(K.kernel_lock_path(cache, kv.version, PLAT), exe_path)

    # A plain (non-force) launch: the fast path used to return the doomed file.
    got = K.ensure_kernel(cache, kv, platform=PLAT)
    thread.join(5)

    assert got.read_text() == "fake kernel"
    assert hits == []


def test_waiting_on_a_live_lock_times_out_with_a_way_out(tmp_path, counting_server, monkeypatch):
    base, _ = counting_server
    kv = make_version(base, version="0.0.0-timeout")
    cache = tmp_path / "cache"
    lock_path = K.kernel_lock_path(cache, kv.version, PLAT)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("1\n")
    monkeypatch.setattr(K, "_KERNEL_LOCK_MAX_WAIT_SECONDS", 0.5)

    with pytest.raises(KernelDownloadError, match="Timed out waiting"):
        K.ensure_kernel(cache, kv, platform=PLAT)


def test_abandoned_temp_zip_is_swept(tmp_path, counting_server):
    base, _ = counting_server
    kv = make_version(base, version="0.0.0-sweep")
    cache = tmp_path / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    abandoned = cache / "kernel-{0}-{1}.zip".format(
        K.normalize_kernel_version(kv.version), PLAT
    )
    abandoned.write_text("half a download")
    old = time.time() - 3 * 60 * 60
    os.utime(abandoned, (old, old))

    K.ensure_kernel(cache, kv, platform=PLAT)

    assert not list(cache.glob("*.zip"))
