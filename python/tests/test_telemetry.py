"""Launch outcome reporting: closed vocabulary, never error text, never fatal."""

from __future__ import annotations

import json

import pytest

from antibrow import browser as B
from antibrow import telemetry as T
from antibrow.errors import ConcurrencyLimitError, KernelDownloadError, LaunchTimeout


@pytest.fixture
def posted(monkeypatch):
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "")
    sent: list = []

    class Response:
        def close(self):
            pass

    def urlopen(request, timeout=None):
        assert request.full_url == "https://api.test/api/v1/telemetry"
        assert request.get_header("User-agent")
        sent.extend(json.loads(request.data)["events"])
        return Response()

    monkeypatch.setattr(T.urllib.request, "urlopen", urlopen)
    return sent


def test_a_failed_launch_is_reported_before_it_raises(tmp_path, posted, monkeypatch):
    def prepare(profile, **kwargs):
        kwargs["on_kernel_download"]("152", False, KernelDownloadError("download failed: network unreachable"))
        raise KernelDownloadError("download failed: network unreachable")

    monkeypatch.setattr(B, "prepare_launch", prepare)
    with pytest.raises(KernelDownloadError):
        B.launch("p", api_key="k", server="https://api.test", cache_dir=tmp_path)

    assert [(e["type"], e["ok"], e.get("code")) for e in posted] == [
        ("kernel.download", False, "network"),
        ("kernel.launch", False, "unknown"),
    ]
    assert posted[1]["meta"] == {"error": "KernelDownloadError"}
    assert all(e["client"] == "sdk-py" and e["kernelVersion"] == "152" for e in posted)


def test_error_text_never_leaves_the_machine(tmp_path, posted, monkeypatch):
    def prepare(profile, **kwargs):
        raise RuntimeError("/Users/me/secret-profile exploded")

    monkeypatch.setattr(B, "prepare_launch", prepare)
    with pytest.raises(RuntimeError):
        B.launch("p", api_key="k", server="https://api.test", cache_dir=tmp_path)

    assert "secret-profile" not in json.dumps(posted)
    assert posted[0]["meta"] == {"error": "RuntimeError"}


def test_turned_off_by_argument_or_environment(tmp_path, posted, monkeypatch):
    monkeypatch.setattr(B, "prepare_launch", lambda profile, **kw: (_ for _ in ()).throw(RuntimeError("x")))
    with pytest.raises(RuntimeError):
        B.launch("p", api_key="k", server="https://api.test", cache_dir=tmp_path, telemetry=False)
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "0")
    with pytest.raises(RuntimeError):
        B.launch("p", api_key="k", server="https://api.test", cache_dir=tmp_path)
    assert posted == []


def test_an_unreachable_api_is_not_a_launch_failure(monkeypatch):
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "")

    def urlopen(request, timeout=None):
        raise OSError("offline")

    monkeypatch.setattr(T.urllib.request, "urlopen", urlopen)
    T.send_telemetry("k", "https://api.test", [{"type": "kernel.launch", "ok": True}])


def test_success_is_sent_in_the_background(posted):
    report = T.LaunchReport("k", "https://api.test")
    report.kernel_download("152", True)
    report.succeeded("152")
    import threading

    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(5)
    assert [(e["type"], e["ok"]) for e in posted] == [("kernel.download", True), ("kernel.launch", True)]


@pytest.mark.parametrize(
    "error, code",
    [
        (ConcurrencyLimitError("limit"), "concurrency"),
        (LaunchTimeout("ran out of time", step="connecting to CDP"), "timeout"),
        (RuntimeError("Failed to obtain license token: 401"), "license"),
        (FileNotFoundError("chrome"), "missing_binary"),
    ],
)
def test_launch_errors_map_onto_the_shared_vocabulary(error, code):
    assert T.classify_launch_error(error) == code


def test_download_errors_map_onto_the_shared_vocabulary():
    assert T.classify_download_error(OSError(28, "No space left on device")) == "disk"
    assert T.classify_download_error(RuntimeError("codesign --verify failed")) == "signature"


def test_the_off_switch_is_read_before_the_background_send(posted, monkeypatch):
    """A switch flipped back after launch returns must not let the queued success through."""
    import threading

    started = threading.Event()
    real_thread = T.threading.Thread

    def slow_thread(target, args, daemon):
        def run():
            started.wait(5)
            target(*args)
        return real_thread(target=run, daemon=daemon)

    monkeypatch.setattr(T.threading, "Thread", slow_thread)
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "0")
    T.LaunchReport("k", "https://api.test").succeeded("152")
    monkeypatch.setenv("ANTIBROW_TELEMETRY", "")
    started.set()
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(5)
    assert posted == []
