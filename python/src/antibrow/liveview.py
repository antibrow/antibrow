"""Watch a running profile from the dashboard.

The kernel is asked for a JPEG screencast over CDP and every frame is forwarded
to the relay over one WebSocket; the dashboard viewer reads the other end. The
browser is not driven by any of this - it is a one-way copy of what the window
already shows.

Needs the ``liveview`` extra (``pip install "antibrow[liveview]"``); nothing
else in the package imports a WebSocket client, so a user who never streams
does not carry one.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Optional

from . import _http
from .errors import LiveViewError

#: Relay the dashboard viewer reads from.
DEFAULT_RELAY_URL = "wss://liveview-relay.antibrow.com"

LIVEVIEW_PATH = "/api/v1/liveview"

#: How often the server is told the session is still alive.
HEARTBEAT_SECONDS = 30.0

#: How long to wait before dialling the relay again after it drops.
RECONNECT_SECONDS = 3.0


@dataclass(frozen=True)
class LiveViewOptions:
    """Frame budget. Lower quality and fewer frames cost less bandwidth."""

    quality: int = 60
    max_width: int = 1280
    max_height: int = 720
    #: Send every Nth frame the compositor produces.
    every_nth_frame: int = 2

    def to_cdp(self) -> dict:
        return {
            "format": "jpeg",
            "quality": self.quality,
            "maxWidth": self.max_width,
            "maxHeight": self.max_height,
            "everyNthFrame": self.every_nth_frame,
        }


@dataclass(frozen=True)
class LiveViewRegistration:
    session_key: str
    relay_token: str
    #: Open this to watch the session.
    view_url: str


def _connect(relay_url: str, session_key: str, relay_token: str) -> Any:
    try:
        from websockets.sync.client import connect
    except ImportError:  # pragma: no cover - depends on the install
        raise LiveViewError(
            'Live View needs a WebSocket client: pip install "antibrow[liveview]"'
        )
    return connect("{0}/produce/{1}?token={2}".format(relay_url.rstrip("/"), session_key, relay_token))


def register_live_session(
    api_key: str,
    server: Optional[str] = None,
    *,
    session_key: str,
    profile_name: Optional[str] = None,
    label: Optional[str] = None,
    ua: Optional[str] = None,
) -> LiveViewRegistration:
    """Claim a session key and get the relay token and dashboard URL for it."""
    payload = {"sessionKey": session_key, "profileName": profile_name, "label": label, "ua": ua}
    status, text = _http.send(
        "POST",
        _http.url_for(server, LIVEVIEW_PATH + "/sessions"),
        api_key=api_key,
        payload={k: v for k, v in payload.items() if v is not None},
    )
    if status not in (200, 201):
        raise LiveViewError("Failed to register the live session: HTTP {0}. {1}".format(status, text.strip()))
    body = _http.parse_json(text)
    body = body if isinstance(body, dict) else {}
    token = body.get("relayToken")
    if not isinstance(token, str) or not token:
        raise LiveViewError("Live session response carried no relay token")
    return LiveViewRegistration(
        session_key=body.get("sessionKey") if isinstance(body.get("sessionKey"), str) else session_key,
        relay_token=token,
        view_url=body.get("viewUrl") if isinstance(body.get("viewUrl"), str) else "",
    )


def unregister_live_session(api_key: str, server: Optional[str] = None, *, session_key: str) -> None:
    """Best effort: the relay drops an idle session on its own after 60s."""
    _http.send("DELETE", _http.url_for(server, "{0}/{1}".format(LIVEVIEW_PATH, session_key)), api_key=api_key)


def heartbeat_live_session(api_key: str, server: Optional[str] = None, *, session_key: str) -> None:
    """Best effort: keep the session from being reaped while it is still open."""
    _http.send("POST", _http.url_for(server, "{0}/{1}".format(LIVEVIEW_PATH, session_key)), api_key=api_key)


class LiveViewStream:
    """Forwards this page's screencast frames to the relay.

    Frames are handed to a sender thread rather than written from the CDP
    callback: Playwright's sync API runs those callbacks on its own dispatcher,
    and a blocking socket write there stalls the browser this is only supposed
    to be watching.

    Only the newest frame is kept while the socket is busy. Live video that
    arrives late is not worth showing, and queueing it would grow without bound
    exactly when the network is already the problem.
    """

    def __init__(
        self,
        context: Any,
        page: Any,
        relay_url: str,
        session_key: str,
        relay_token: str,
        options: Optional[LiveViewOptions] = None,
    ) -> None:
        self._context = context
        self._page = page
        self._relay_url = relay_url or DEFAULT_RELAY_URL
        self._session_key = session_key
        self._relay_token = relay_token
        self._options = options or LiveViewOptions()

        self._cdp: Any = None
        self._ws: Any = None
        self._running = False
        self._pending: Optional[str] = None
        self._frame = threading.Condition()
        self._stopped = threading.Event()
        self._sender: Optional[threading.Thread] = None

    @property
    def is_running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        try:
            self._ws = _connect(self._relay_url, self._session_key, self._relay_token)
        except Exception:
            self._running = False
            raise
        self._sender = threading.Thread(target=self._pump, name="antibrow-liveview", daemon=True)
        self._sender.start()
        self._start_screencast()

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        self._stopped.set()
        with self._frame:
            self._frame.notify_all()
        self._stop_screencast()
        if self._sender is not None:
            self._sender.join(timeout=5)
            self._sender = None
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    def _start_screencast(self) -> None:
        try:
            self._cdp = self._context.new_cdp_session(self._page)
            self._cdp.on("Page.screencastFrame", self._on_frame)
            self._cdp.send("Page.startScreencast", self._options.to_cdp())
        except Exception:
            # A page that closed between the launch and here is not worth
            # failing a browsing session over.
            self._cdp = None

    def _stop_screencast(self) -> None:
        if self._cdp is None:
            return
        try:
            self._cdp.send("Page.stopScreencast")
            self._cdp.detach()
        except Exception:
            pass
        self._cdp = None

    def _on_frame(self, params: dict) -> None:
        # Acknowledge first: the kernel sends no further frame until it is
        # acked, so dropping this would freeze the stream rather than thin it.
        try:
            self._cdp.send("Page.screencastFrameAck", {"sessionId": params.get("sessionId")})
        except Exception:
            pass
        data = params.get("data")
        if not isinstance(data, str):
            return
        with self._frame:
            self._pending = data
            self._frame.notify()

    def _pump(self) -> None:
        while self._running:
            with self._frame:
                while self._running and self._pending is None:
                    self._frame.wait(timeout=1.0)
                data, self._pending = self._pending, None
            if not self._running or data is None:
                continue
            try:
                self._ws.send(data)
            except Exception:
                self._reconnect()

    def _reconnect(self) -> None:
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:
            pass
        self._ws = None
        while self._running:
            if self._stopped.wait(RECONNECT_SECONDS):
                return
            try:
                self._ws = _connect(self._relay_url, self._session_key, self._relay_token)
                return
            except Exception:
                continue


class LiveViewSession:
    """A registered live view: the relay stream plus the keep-alive behind it."""

    def __init__(
        self,
        stream: LiveViewStream,
        registration: LiveViewRegistration,
        api_key: str,
        server: Optional[str],
    ) -> None:
        self._stream = stream
        self._registration = registration
        self._api_key = api_key
        self._server = server
        self._stop = threading.Event()
        self._heartbeat = threading.Thread(
            target=self._beat, name="antibrow-liveview-heartbeat", daemon=True
        )
        self._heartbeat.start()

    @property
    def session_key(self) -> str:
        return self._registration.session_key

    @property
    def view_url(self) -> str:
        """Open this in a browser to watch the session."""
        return self._registration.view_url

    def stop(self) -> None:
        """Stop streaming and release the session. Never raises."""
        self._stop.set()
        try:
            self._stream.stop()
        except Exception:
            pass
        try:
            unregister_live_session(self._api_key, self._server, session_key=self.session_key)
        except Exception:
            pass

    def _beat(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            try:
                heartbeat_live_session(self._api_key, self._server, session_key=self.session_key)
            except Exception:
                pass

    def __repr__(self) -> str:
        return "<LiveViewSession {0}>".format(self.view_url or self.session_key)


__all__ = [
    "DEFAULT_RELAY_URL",
    "LiveViewOptions",
    "LiveViewRegistration",
    "LiveViewSession",
    "LiveViewStream",
    "heartbeat_live_session",
    "register_live_session",
    "unregister_live_session",
]
