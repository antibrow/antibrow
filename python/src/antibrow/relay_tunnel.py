"""fp-relay/1 client: one HTTP request through an encrypted relay tunnel.

The kernel speaks this protocol natively for ``relay://…?key=`` proxies. The SDK
needs it too, for the one request it makes before the browser starts: the exit
IP lookup that sets the timezone and WebRTC identity. Probing over the relay's
legacy header endpoint instead would force every self-hosted deployment to
enable plaintext mode, which is the thing this transport exists to avoid.

The WebSocket framing here is written out rather than pulled from a dependency:
it is one short exchange, and ``websockets`` is an optional extra used only by
Live View.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import socket
import ssl
import struct
import urllib.parse
from typing import Optional, Tuple

AAD = b"fp-relay/1"
INFO_C2S = b"fp-relay/1 c2s"
INFO_S2C = b"fp-relay/1 s2c"
SALT_LEN = 32
PSK_LEN = 32
STATUS_OK = 0
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class RelayTunnelError(Exception):
    """The tunnel could not be opened, or died before the response arrived."""


def _aesgcm(key: bytes):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover - packaging guarantees it
        raise RelayTunnelError(
            "the encrypted relay needs the 'cryptography' package"
        ) from exc
    return AESGCM(key)


def _hkdf32(psk: bytes, salt: bytes, info: bytes) -> bytes:
    prk = hmac.new(salt, psk, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()


def _nonce(counter: int) -> bytes:
    return b"\x00\x00\x00\x00" + struct.pack(">Q", counter)


def decode_relay_key(value: str) -> bytes:
    """Decode a base64url ``?key=``. Raises unless it is exactly 32 bytes."""
    padded = value + "=" * (-len(value) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
    except Exception:
        raw = b""
    if len(raw) != PSK_LEN:
        raise RelayTunnelError(
            "relay key must decode to {0} bytes, got {1}".format(PSK_LEN, len(raw))
        )
    return raw


def _encode_init(host: str, port: int, cred: str) -> bytes:
    """ver:u8 | hostLen:u8 | host | port:u16be | credLen:u16be | cred"""
    h = host.encode()
    c = cred.encode()
    if len(h) > 255:
        raise RelayTunnelError("relay target host too long")
    return (
        bytes([1, len(h)]) + h + struct.pack(">H", port) + struct.pack(">H", len(c)) + c
    )


class _WebSocket:
    """The client half of RFC 6455, binary frames only."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.buf = b""

    def handshake(self, host_header: str, path: str) -> None:
        nonce = base64.b64encode(os.urandom(16))
        req = (
            "GET {0} HTTP/1.1\r\nHost: {1}\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: {2}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).format(path or "/", host_header, nonce.decode())
        self.sock.sendall(req.encode())
        head = self._read_until(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0]
        if b" 101" not in status:
            raise RelayTunnelError(
                "relay refused the websocket upgrade: {0}".format(
                    status.decode("latin-1", "replace")
                )
            )
        expect = base64.b64encode(hashlib.sha1(nonce + WS_GUID).digest()).decode()
        accept = re.search(rb"sec-websocket-accept:\s*(\S+)", head, re.I)
        if not accept or accept.group(1).decode() != expect:
            raise RelayTunnelError("relay returned a bad websocket accept header")

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RelayTunnelError("relay closed the connection during the handshake")
            self.buf += chunk
        head, self.buf = self.buf.split(marker, 1)
        return head + marker

    def _read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_binary(self, payload: bytes) -> None:
        header = bytearray([0x82])  # FIN + binary
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv_message(self) -> Optional[bytes]:
        """Next data message, or None once the peer closes."""
        payload = b""
        while True:
            try:
                b0, b1 = self._read_exact(2)
            except EOFError:
                return None
            opcode = b0 & 0x0F
            fin = bool(b0 & 0x80)
            length = b1 & 0x7F
            try:
                if length == 126:
                    length = struct.unpack(">H", self._read_exact(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self._read_exact(8))[0]
                data = self._read_exact(length) if length else b""
            except EOFError:
                return None
            if opcode == 0x8:  # close
                return None
            if opcode == 0x9:  # ping - the relay is entitled to send these
                self._send_control(0xA, data)
                continue
            if opcode == 0xA:
                continue
            payload += data
            if fin:
                return payload

    def _send_control(self, opcode: int, data: bytes) -> None:
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes([0x80 | opcode, 0x80 | len(data)]) + mask + masked)

    def close(self) -> None:
        try:
            self._send_control(0x8, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def _connect(host: str, port: int, timeout: float, insecure: bool) -> socket.socket:
    raw = socket.create_connection((host, port), timeout=timeout)
    if insecure:
        return raw
    ctx = ssl.create_default_context()
    return ctx.wrap_socket(raw, server_hostname=host)


def relay_fetch(
    relay_url: str,
    *,
    host: str,
    port: int,
    path: str,
    timeout: float = 10.0,
    insecure: bool = False,
) -> str:
    """Fetch one plaintext-HTTP URL through the relay; returns the body.

    ``insecure`` speaks ws:// instead of wss:// and exists for tests against a
    local relay.
    """
    parsed = urllib.parse.urlsplit(relay_url)
    if not parsed.hostname:
        raise RelayTunnelError("relay url has no host: {0!r}".format(relay_url))
    key_param = dict(urllib.parse.parse_qsl(parsed.query)).get("key")
    if not key_param:
        raise RelayTunnelError("relay url carries no ?key=, so it has no encrypted mode")
    psk = decode_relay_key(key_param)

    relay_port = parsed.port or (80 if insecure else 443)
    cred = ""
    if parsed.username:
        cred = "{0}:{1}".format(
            urllib.parse.unquote(parsed.username),
            urllib.parse.unquote(parsed.password or ""),
        )

    salt = os.urandom(SALT_LEN)
    c2s = _aesgcm(_hkdf32(psk, salt, INFO_C2S))
    s2c = _aesgcm(_hkdf32(psk, salt, INFO_S2C))

    ws = _WebSocket(_connect(parsed.hostname, relay_port, timeout, insecure))
    try:
        host_header = parsed.hostname if parsed.port is None else "{0}:{1}".format(
            parsed.hostname, relay_port
        )
        ws.handshake(host_header, parsed.path or "/")
        ws.send_binary(salt + c2s.encrypt(_nonce(0), _encode_init(host, port, cred), AAD))
        request = (
            "GET {0} HTTP/1.1\r\nHost: {1}\r\nAccept: application/json\r\n"
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n"
        ).format(path, host)
        ws.send_binary(c2s.encrypt(_nonce(1), request.encode(), AAD))

        first = ws.recv_message()
        if first is None:
            # Every rejection - bad key, bad credential, dead upstream - closes
            # the socket without a word. Saying so beats an empty body.
            raise RelayTunnelError(
                "relay closed the connection before the tunnel opened "
                "(key, credential or upstream refused)"
            )
        try:
            status = s2c.decrypt(_nonce(0), first, AAD)
        except Exception as exc:
            raise RelayTunnelError("could not open the relay's first frame: wrong key?") from exc
        if not status or status[0] != STATUS_OK:
            raise RelayTunnelError("relay refused the tunnel, status {0}".format(status[:1]))

        raw = ""
        counter = 1
        while True:
            frame = ws.recv_message()
            if frame is None:
                break
            try:
                raw += s2c.decrypt(_nonce(counter), frame, AAD).decode("latin-1")
            except Exception as exc:
                raise RelayTunnelError("relay frame failed authentication") from exc
            counter += 1
            if _complete(raw):
                break
        return _http_body(raw)
    except (OSError, ssl.SSLError) as exc:
        raise RelayTunnelError("relay connection failed: {0}".format(exc)) from exc
    finally:
        ws.close()


def _split_head(raw: str) -> Optional[Tuple[str, str]]:
    at = raw.find("\r\n\r\n")
    if at < 0:
        return None
    return raw[:at], raw[at + 4 :]


def _complete(raw: str) -> bool:
    parts = _split_head(raw)
    if parts is None:
        return False
    head, body = parts
    if re.search(r"transfer-encoding:\s*chunked", head, re.I):
        return "\r\n0\r\n" in body
    declared = re.search(r"content-length:\s*(\d+)", head, re.I)
    return declared is not None and len(body) >= int(declared.group(1))


def _http_body(raw: str) -> str:
    parts = _split_head(raw)
    if parts is None:
        raise RelayTunnelError("relay tunnel closed without a complete HTTP response")
    head, body = parts
    if re.search(r"transfer-encoding:\s*chunked", head, re.I):
        return _dechunk(body)
    declared = re.search(r"content-length:\s*(\d+)", head, re.I)
    if declared is not None and len(body) != int(declared.group(1)):
        raise RelayTunnelError(
            "relay response truncated: declared {0} bytes, got {1}".format(
                declared.group(1), len(body)
            )
        )
    return body


def _dechunk(body: str) -> str:
    out = ""
    rest = body
    while True:
        at = rest.find("\r\n")
        if at < 0:
            break
        try:
            size = int(rest[:at].split(";")[0], 16)
        except ValueError:
            break
        if size == 0:
            break
        out += rest[at + 2 : at + 2 + size]
        rest = rest[at + 2 + size + 2 :]
    return out
