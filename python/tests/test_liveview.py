"""Live View: registration, and the frame path from CDP to the relay socket.

The stream is a one-way copy of what the window already shows, so the rules it
has to keep are about not disturbing the browser: acknowledge every frame (the
kernel sends no further one until then), never write to a socket from the CDP
callback, and never take a browsing session down because the relay is unhappy.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from antibrow import liveview as LV
from antibrow.errors import LiveViewError


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        self.server.calls.append({"method": self.command, "path": self.path, "body": json.loads(body) if body else None})
        status, payload = self.server.routes.get((self.command, self.path.split("?")[0]), (404, {}))
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = do_POST = do_DELETE = _respond


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.routes = {}
    httpd.calls = []
    httpd.url = "http://127.0.0.1:{0}".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


class FakeSocket:
    """Stands in for the relay connection."""

    def __init__(self, fail_times=0):
        self.sent = []
        self.closed = False
        self._fail = fail_times
        self._got = threading.Event()

    def send(self, data):
        if self._fail > 0:
            self._fail -= 1
            raise OSError("relay went away")
        self.sent.append(data)
        self._got.set()

    def close(self):
        self.closed = True

    def wait(self, timeout=2.0):
        return self._got.wait(timeout)


class FakeCDP:
    def __init__(self):
        self.sent = []
        self.handlers = {}
        self.detached = False

    def send(self, method, params=None):
        self.sent.append((method, params))

    def on(self, event, handler):
        self.handlers[event] = handler

    def detach(self):
        self.detached = True

    def emit_frame(self, data, session_id=1):
        self.handlers["Page.screencastFrame"]({"data": data, "sessionId": session_id})


class FakeContext:
    def __init__(self, cdp):
        self._cdp = cdp

    def new_cdp_session(self, _page):
        return self._cdp


@pytest.fixture
def stream(monkeypatch):
    """A started stream over a fake CDP session and a fake relay socket."""
    sockets = []

    def connect(*_args):
        sockets.append(FakeSocket())
        return sockets[-1]

    monkeypatch.setattr(LV, "_connect", connect)
    cdp = FakeCDP()
    s = LV.LiveViewStream(FakeContext(cdp), object(), "wss://relay", "sess-1", "tok-1")
    s.start()
    try:
        yield s, cdp, sockets
    finally:
        s.stop()


class TestRegistration:
    def test_returns_the_relay_token_and_the_url_to_watch(self, server):
        server.routes[("POST", "/api/v1/liveview/sessions")] = (
            200,
            {"sessionKey": "sess-1", "relayToken": "tok-1", "viewUrl": "https://antibrow.com/live/sess-1"},
        )

        registration = LV.register_live_session(
            "adb_k", server.url, session_key="sess-1", profile_name="shopper"
        )

        assert registration.relay_token == "tok-1"
        assert registration.view_url.endswith("/live/sess-1")
        assert server.calls[0]["body"] == {"sessionKey": "sess-1", "profileName": "shopper"}

    def test_a_response_without_a_token_is_an_error_not_a_dead_stream(self, server):
        server.routes[("POST", "/api/v1/liveview/sessions")] = (200, {"sessionKey": "sess-1"})

        with pytest.raises(LiveViewError, match="relay token"):
            LV.register_live_session("adb_k", server.url, session_key="sess-1")

    def test_a_refusal_is_reported_with_its_status(self, server):
        server.routes[("POST", "/api/v1/liveview/sessions")] = (402, {"error": "upgrade_required"})

        with pytest.raises(LiveViewError, match="402"):
            LV.register_live_session("adb_k", server.url, session_key="sess-1")

    def test_unregister_and_heartbeat_never_raise(self, server):
        # Both are best effort: the relay drops an idle session on its own.
        LV.unregister_live_session("adb_k", server.url, session_key="sess-1")
        LV.heartbeat_live_session("adb_k", server.url, session_key="sess-1")

        assert [c["method"] for c in server.calls] == ["DELETE", "POST"]


class TestStreaming:
    def test_starts_the_screencast_with_the_requested_frame_budget(self, monkeypatch):
        monkeypatch.setattr(LV, "_connect", lambda *a: FakeSocket())
        cdp = FakeCDP()
        stream = LV.LiveViewStream(
            FakeContext(cdp), object(), "wss://relay", "s", "t", LV.LiveViewOptions(quality=30, max_width=640)
        )
        stream.start()
        try:
            method, params = cdp.sent[0]
            assert method == "Page.startScreencast"
            assert params["quality"] == 30
            assert params["maxWidth"] == 640
            assert params["format"] == "jpeg"
        finally:
            stream.stop()

    def test_every_frame_is_acknowledged(self, stream):
        s, cdp, sockets = stream

        cdp.emit_frame("aaa", session_id=7)

        # Without the ack the kernel sends no further frame, so a dropped ack
        # freezes the stream instead of thinning it.
        assert ("Page.screencastFrameAck", {"sessionId": 7}) in cdp.sent
        assert sockets[0].wait()
        assert sockets[0].sent == ["aaa"]

    def test_frames_are_written_off_the_cdp_callback_thread(self, stream):
        s, cdp, sockets = stream
        callback_thread = []

        original = sockets[0].send

        def record(data):
            callback_thread.append(threading.current_thread().name)
            original(data)

        sockets[0].send = record
        cdp.emit_frame("aaa")
        assert sockets[0].wait()

        # A blocking socket write on Playwright's dispatcher would stall the
        # browser this is only supposed to be watching.
        assert callback_thread[0] != threading.current_thread().name

    def test_a_dropped_relay_reconnects_instead_of_ending_the_session(self, monkeypatch):
        monkeypatch.setattr(LV, "RECONNECT_SECONDS", 0.01)
        sockets = [FakeSocket(fail_times=1), FakeSocket()]
        handed = iter(sockets)
        monkeypatch.setattr(LV, "_connect", lambda *a: next(handed))

        cdp = FakeCDP()
        stream = LV.LiveViewStream(FakeContext(cdp), object(), "wss://relay", "s", "t")
        stream.start()
        try:
            cdp.emit_frame("first")  # lost to the failing socket
            deadline = time.time() + 3
            while time.time() < deadline and not sockets[1].sent:
                cdp.emit_frame("second")
                time.sleep(0.02)
            assert sockets[1].sent
        finally:
            stream.stop()

    def test_stop_ends_the_screencast_and_closes_the_socket(self, monkeypatch):
        socket = FakeSocket()
        monkeypatch.setattr(LV, "_connect", lambda *a: socket)
        cdp = FakeCDP()
        stream = LV.LiveViewStream(FakeContext(cdp), object(), "wss://relay", "s", "t")
        stream.start()

        stream.stop()

        assert ("Page.stopScreencast", None) in cdp.sent
        assert cdp.detached is True
        assert socket.closed is True
        assert stream.is_running is False

    def test_stop_is_idempotent(self, monkeypatch):
        monkeypatch.setattr(LV, "_connect", lambda *a: FakeSocket())
        stream = LV.LiveViewStream(FakeContext(FakeCDP()), object(), "wss://relay", "s", "t")
        stream.start()

        stream.stop()
        stream.stop()

    def test_a_page_that_died_before_the_screencast_does_not_kill_the_launch(self, monkeypatch):
        monkeypatch.setattr(LV, "_connect", lambda *a: FakeSocket())

        class DeadContext:
            def new_cdp_session(self, _page):
                raise RuntimeError("Target page has been closed")

        stream = LV.LiveViewStream(DeadContext(), object(), "wss://relay", "s", "t")
        stream.start()
        try:
            assert stream.is_running is True
        finally:
            stream.stop()

    def test_a_missing_websocket_client_says_which_extra_to_install(self, monkeypatch):
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("websockets"):
                raise ImportError("No module named 'websockets'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        with pytest.raises(LiveViewError, match=r"antibrow\[liveview\]"):
            LV._connect("wss://relay", "s", "t")


class TestLaunchWiring:
    """The two launch paths reach the same starter with a real page object."""

    def _plan(self, tmp_path):
        from antibrow.browser import LaunchPlan
        from antibrow.license import LicenseInfo
        from antibrow.persona import generate_persona

        return LaunchPlan(
            exe_path=tmp_path / "chrome",
            args=[],
            cdp_port=1,
            profile_dir=tmp_path,
            user_data_dir=tmp_path / "user-data",
            persona=generate_persona(151, "151"),
            timezone="UTC",
            label="p1",
            kernel_version="151",
            license=LicenseInfo(token="t", exp=2**31, mi=1, sync=False),
        )

    def test_registration_and_stream_get_the_page(self, tmp_path, monkeypatch):
        from antibrow import browser as B

        seen = {}
        monkeypatch.setenv("ANTIBROW_API_KEY", "adb_k")
        monkeypatch.setattr(
            B,
            "register_live_session",
            lambda *a, **k: LV.LiveViewRegistration("s", "tok", "https://antibrow.com/live/s"),
        )

        class Stream:
            def __init__(self, context, page, *_args):
                seen["page"] = page

            def start(self):
                seen["started"] = True

            def stop(self):
                pass

        monkeypatch.setattr(B, "LiveViewStream", Stream)
        monkeypatch.setattr(B, "LiveViewSession", lambda stream, reg, key, server: reg)

        page = object()
        result = B._start_live_view(
            object(),
            page,
            live_view=True,
            relay_url=None,
            api_key=None,
            server=None,
            plan=self._plan(tmp_path),
            notify=lambda _m: None,
        )

        assert seen == {"page": page, "started": True}
        assert result.view_url.endswith("/live/s")

    def test_without_an_api_key_the_launch_just_carries_on(self, tmp_path, monkeypatch):
        from antibrow import browser as B

        monkeypatch.delenv("ANTIBROW_API_KEY", raising=False)
        monkeypatch.setattr(B, "resolve_api_key", lambda _k: None)
        notes = []

        assert (
            B._start_live_view(
                object(),
                object(),
                live_view=True,
                relay_url=None,
                api_key=None,
                server=None,
                plan=self._plan(tmp_path),
                notify=notes.append,
            )
            is None
        )
        assert any("API key" in note for note in notes)

    def test_a_relay_that_refuses_does_not_fail_the_launch(self, tmp_path, monkeypatch):
        from antibrow import browser as B

        monkeypatch.setenv("ANTIBROW_API_KEY", "adb_k")

        def boom(*_a, **_k):
            raise LiveViewError("HTTP 402")

        monkeypatch.setattr(B, "register_live_session", boom)
        notes = []

        assert (
            B._start_live_view(
                object(),
                object(),
                live_view=True,
                relay_url=None,
                api_key=None,
                server=None,
                plan=self._plan(tmp_path),
                notify=notes.append,
            )
            is None
        )
        assert any("402" in note for note in notes)


@pytest.mark.asyncio
async def test_async_launch_awaits_the_page_coroutine():
    """`AsyncAntibrow.page` is a coroutine method, not a property.

    `await session.page` type-checks as nothing and raises at runtime, which is
    exactly the shape of bug an async path with no test hides.
    """
    import inspect

    from antibrow.browser import AsyncAntibrow

    assert inspect.iscoroutinefunction(AsyncAntibrow.page)
