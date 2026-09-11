"""fp-relay/1 client: the encrypted path the geo probe uses.

The server half here is written from the protocol description rather than from
our client, so a client that drifts off the wire format fails these.
"""

import base64
import hashlib
import hmac
import os
import struct
import threading

import pytest

websockets_sync = pytest.importorskip("websockets.sync.server")

from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

from antibrow.relay_tunnel import RelayTunnelError, relay_fetch  # noqa: E402

AAD = b"fp-relay/1"
BODY = '{"status":"success","query":"203.0.113.7"}'
OK = (
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
    "Content-Length: {0}\r\n\r\n{1}".format(len(BODY), BODY)
)


def hkdf32(psk: bytes, salt: bytes, info: bytes) -> bytes:
    prk = hmac.new(salt, psk, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()


def nonce(counter: int) -> bytes:
    return b"\x00\x00\x00\x00" + struct.pack(">Q", counter)


class FakeRelay:
    """A relay that answers one tunnel with a canned HTTP response."""

    def __init__(self, psk: bytes, reply: str = OK, accept: bool = True):
        self.psk = psk
        self.reply = reply
        self.accept = accept
        self.init = None
        self.request = ""
        self.server = websockets_sync.serve(self._handle, "127.0.0.1", 0)
        self.port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()

    def _handle(self, ws):
        first = ws.recv()
        if not self.accept:
            ws.close()
            return
        salt, sealed = first[:32], first[32:]
        c2s = AESGCM(hkdf32(self.psk, salt, b"fp-relay/1 c2s"))
        s2c = AESGCM(hkdf32(self.psk, salt, b"fp-relay/1 s2c"))
        init = c2s.decrypt(nonce(0), sealed, AAD)
        host_len = init[1]
        host = init[2 : 2 + host_len].decode()
        port = struct.unpack(">H", init[2 + host_len : 4 + host_len])[0]
        cred_len = struct.unpack(">H", init[4 + host_len : 6 + host_len])[0]
        cred = init[6 + host_len : 6 + host_len + cred_len].decode()
        self.init = (host, port, cred)
        ws.send(s2c.encrypt(nonce(0), b"\x00", AAD))

        recv = 1
        send = 1
        while "\r\n\r\n" not in self.request:
            self.request += c2s.decrypt(nonce(recv), ws.recv(), AAD).decode()
            recv += 1
        ws.send(s2c.encrypt(nonce(send), self.reply.encode(), AAD))
        ws.close()


@pytest.fixture
def psk():
    return os.urandom(32)


def relay_url(port: int, psk: bytes, cred: str = "alice:s3cret") -> str:
    key = base64.urlsafe_b64encode(psk).decode().rstrip("=")
    return "relay://{0}@127.0.0.1:{1}?key={2}".format(cred, port, key)


def test_target_and_credential_travel_inside_the_sealed_init_frame(psk):
    relay = FakeRelay(psk)
    try:
        body = relay_fetch(
            relay_url(relay.port, psk), host="ip-api.com", port=80, path="/json",
            timeout=5.0, insecure=True,
        )
    finally:
        relay.close()

    assert body == BODY
    assert relay.init == ("ip-api.com", 80, "alice:s3cret")
    assert relay.request.startswith("GET /json HTTP/1.1")


def test_a_silent_rejection_is_reported_not_swallowed(psk):
    # Every failure path on the relay closes without a reply - that silence is
    # the protocol's anti-probe property, so the client has to name it.
    relay = FakeRelay(psk, accept=False)
    try:
        with pytest.raises(RelayTunnelError, match="closed the connection"):
            relay_fetch(
                relay_url(relay.port, psk), host="ip-api.com", port=80, path="/json",
                timeout=5.0, insecure=True,
            )
    finally:
        relay.close()


def test_wrong_key_fails_instead_of_returning_garbage(psk):
    relay = FakeRelay(os.urandom(32))
    try:
        with pytest.raises(RelayTunnelError):
            relay_fetch(
                relay_url(relay.port, psk), host="ip-api.com", port=80, path="/json",
                timeout=5.0, insecure=True,
            )
    finally:
        relay.close()


def test_a_truncated_response_is_an_error_not_a_short_body(psk):
    short = "HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n{}"
    relay = FakeRelay(psk, reply=short)
    try:
        with pytest.raises(RelayTunnelError, match="truncated"):
            relay_fetch(
                relay_url(relay.port, psk), host="ip-api.com", port=80, path="/json",
                timeout=5.0, insecure=True,
            )
    finally:
        relay.close()
