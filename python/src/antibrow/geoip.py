"""Exit-node geolocation, looked up *through* the proxy.

A residential proxy in Los Angeles with a browser reporting Europe/Berlin is one
of the cheapest signals to fail on, so the timezone written into fp-config comes
from the proxy's own exit IP - queried over the very connection the browser will
use, not from the local machine.

Implemented on raw sockets rather than an HTTP client library for two reasons:
the request must go *to* the proxy with an absolute-form request line, and
``Proxy-Authorization`` is a forbidden header that most high-level clients strip
silently. No third-party dependency is needed.
"""

from __future__ import annotations

import base64
import json
import socket
import ssl
import struct
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from .proxy import ProxyLike, ProxySpec, parse_proxy

GEO_HOST = "ip-api.com"
GEO_PATH = "/json/?fields=status,country,countryCode,timezone,query"
GEO_URL = "http://{0}{1}".format(GEO_HOST, GEO_PATH)

DEFAULT_TIMEOUT = 10.0


@dataclass
class ProxyGeo:
    ip: str
    country: str
    timezone: str
    country_code: str = ""
    rtt_ms: Optional[float] = None


def parse_geo_response(body: str) -> Optional[ProxyGeo]:
    """Parse an ip-api.com JSON body. Returns None for anything unexpected."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("status") != "success":
        return None
    return ProxyGeo(
        ip=data.get("query") or "",
        country=data.get("country") or "",
        timezone=data.get("timezone") or "",
        country_code=data.get("countryCode") or "",
    )


def split_http_response(raw: bytes) -> Tuple[str, str]:
    """Split a raw HTTP/1.x response into (headers, body), de-chunking if needed."""
    text = raw.decode("utf-8", "replace")
    if "\r\n\r\n" in text:
        head, body = text.split("\r\n\r\n", 1)
    elif "\n\n" in text:
        head, body = text.split("\n\n", 1)
    else:
        return "", text
    if "chunked" in head.lower():
        body = dechunk(body)
    return head, body


def dechunk(body: str) -> str:
    """Decode a ``Transfer-Encoding: chunked`` body; returns input on any doubt."""
    out = []
    rest = body
    while rest:
        line, sep, remainder = rest.partition("\r\n")
        if not sep:
            break
        size_token = line.split(";")[0].strip()
        try:
            size = int(size_token, 16)
        except ValueError:
            return body
        if size == 0:
            break
        out.append(remainder[:size])
        rest = remainder[size:].lstrip("\r\n")
    return "".join(out) if out else body


def _basic_auth(spec: ProxySpec) -> str:
    creds = "{0}:{1}".format(spec.username or "", spec.password or "")
    return "Basic " + base64.b64encode(creds.encode("utf-8")).decode("ascii")


def _read_all(sock: socket.socket, limit: int = 64 * 1024) -> bytes:
    chunks = []
    total = 0
    while total < limit:
        chunk = sock.recv(8192)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def _lookup_via_http_proxy(spec: ProxySpec, timeout: float) -> Optional[ProxyGeo]:
    """Absolute-form GET straight at the proxy (no CONNECT needed for http://)."""
    port = spec.port or (443 if spec.scheme == "https" else 80)
    lines = [
        "GET {0} HTTP/1.1".format(GEO_URL),
        "Host: {0}".format(GEO_HOST),
        "Accept: application/json",
        "User-Agent: antibrow-python",
        "Connection: close",
    ]
    if spec.has_credentials:
        lines.append("Proxy-Authorization: " + _basic_auth(spec))
    request = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")

    sock = socket.create_connection((spec.host, port), timeout=timeout)
    try:
        if spec.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=spec.host)
        sock.sendall(request)
        _, body = split_http_response(_read_all(sock))
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return parse_geo_response(body)


def _lookup_via_relay(spec: ProxySpec, timeout: float) -> Optional[ProxyGeo]:
    """Managed relay: a normal HTTPS request whose real target is a header.

    Same path the kernel takes (``X-Proxy-Target`` + ``Proxy-Authorization``), so
    the geo we read is the geo the browser will actually exit from.
    """
    port = spec.port or 443
    lines = [
        "GET / HTTP/1.1",
        "Host: {0}".format(spec.host),
        "X-Proxy-Target: {0}".format(GEO_URL),
        "Proxy-Authorization: " + _basic_auth(spec),
        "Accept: application/json",
        "Connection: close",
    ]
    request = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")

    raw = socket.create_connection((spec.host, port), timeout=timeout)
    try:
        sock = ssl.create_default_context().wrap_socket(raw, server_hostname=spec.host)
        try:
            sock.sendall(request)
            _, body = split_http_response(_read_all(sock))
        finally:
            sock.close()
    finally:
        try:
            raw.close()
        except OSError:
            pass
    return parse_geo_response(body)


def socks5_connect(
    sock: socket.socket,
    host: str,
    port: int,
    username: Optional[str] = None,
    password: Optional[str] = None,
) -> None:
    """Minimal SOCKS5 handshake (RFC 1928 + RFC 1929 user/pass auth).

    Raises OSError on any protocol failure so callers can treat it like any
    other socket error.
    """
    methods = b"\x00\x02" if username else b"\x00"
    sock.sendall(b"\x05" + bytes([len(methods)]) + methods)
    greeting = sock.recv(2)
    if len(greeting) != 2 or greeting[0] != 0x05:
        raise OSError("SOCKS5: malformed greeting response")
    method = greeting[1]
    if method == 0x02:
        if not username:
            raise OSError("SOCKS5: proxy demands auth but no credentials were given")
        user = username.encode("utf-8")
        secret = (password or "").encode("utf-8")
        sock.sendall(b"\x01" + bytes([len(user)]) + user + bytes([len(secret)]) + secret)
        reply = sock.recv(2)
        if len(reply) != 2 or reply[1] != 0x00:
            raise OSError("SOCKS5: authentication rejected")
    elif method != 0x00:
        raise OSError("SOCKS5: no acceptable authentication method (0x{0:02x})".format(method))

    target = host.encode("idna") if any(ord(c) > 127 for c in host) else host.encode("ascii")
    sock.sendall(b"\x05\x01\x00\x03" + bytes([len(target)]) + target + struct.pack(">H", port))
    reply = sock.recv(4)
    if len(reply) != 4 or reply[1] != 0x00:
        raise OSError("SOCKS5: CONNECT refused (0x{0:02x})".format(reply[1] if len(reply) > 1 else 0xFF))
    atyp = reply[3]
    if atyp == 0x01:
        sock.recv(4 + 2)
    elif atyp == 0x03:
        length = sock.recv(1)[0]
        sock.recv(length + 2)
    elif atyp == 0x04:
        sock.recv(16 + 2)
    else:
        raise OSError("SOCKS5: unknown address type in reply")


def _lookup_via_socks5(spec: ProxySpec, timeout: float) -> Optional[ProxyGeo]:
    sock = socket.create_connection((spec.host, spec.port or 1080), timeout=timeout)
    try:
        socks5_connect(sock, GEO_HOST, 80, spec.username, spec.password)
        request = (
            "GET {0} HTTP/1.1\r\nHost: {1}\r\nAccept: application/json\r\n"
            "User-Agent: antibrow-python\r\nConnection: close\r\n\r\n"
        ).format(GEO_PATH, GEO_HOST).encode("utf-8")
        sock.sendall(request)
        _, body = split_http_response(_read_all(sock))
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return parse_geo_response(body)


def lookup_proxy_geo(proxy: ProxyLike, timeout: float = DEFAULT_TIMEOUT) -> Optional[ProxyGeo]:
    """Resolve the exit IP + timezone of a proxy. Returns None on any failure.

    Never raises: a geo lookup that fails degrades to the persona's stored
    timezone rather than blocking the launch.
    """
    try:
        spec = parse_proxy(proxy)
    except Exception:
        return None
    if spec is None:
        return None
    start = time.monotonic()
    try:
        if spec.is_relay:
            geo = _lookup_via_relay(spec, timeout)
        elif spec.is_socks:
            geo = _lookup_via_socks5(spec, timeout)
        else:
            geo = _lookup_via_http_proxy(spec, timeout)
    except Exception:
        return None
    if geo is not None:
        # Includes DNS, connect and TLS, so it overestimates Chrome's http_rtt -
        # deliberately not compensated: erring slow only yields a slower
        # effectiveType, which is still a self-consistent trio.
        geo.rtt_ms = (time.monotonic() - start) * 1000
    return geo
