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
import os
import socket
import ssl
import struct
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from .config import USER_AGENT
from .proxy import ProxyLike, ProxySpec, parse_proxy

GEO_HOST = "ip-api.com"
GEO_PATH = "/json/?fields=status,country,countryCode,city,timezone,query"
GEO_URL = "http://{0}{1}".format(GEO_HOST, GEO_PATH)

DEFAULT_GEO_SERVER = "https://antibrow.com"
DEFAULT_TIMEOUT = 10.0
# Our own endpoint gets a short leash so a slow edge cannot eat the whole budget
# and leave nothing for the fallback.
OWN_TARGET_TIMEOUT = 4.0


@dataclass(frozen=True)
class GeoTarget:
    """One place a probe can ask "where did this connection come out?"."""

    url: str
    host: str
    port: int
    path: str
    # Our own endpoint is HTTPS: the proxy operator would otherwise see the
    # product's hostname in clear text, which ip-api never revealed.
    tls: bool
    kind: str


IPAPI_TARGET = GeoTarget(
    url=GEO_URL, host=GEO_HOST, port=80, path=GEO_PATH, tls=False, kind="ipapi"
)


def geo_targets(server_url: Optional[str] = None) -> List[GeoTarget]:
    """Ours first, ip-api behind it.

    A launch must not depend on our own uptime: a geo lookup that resolves to
    nothing leaves the persona on a timezone its exit IP disagrees with.
    """
    base = server_url or os.environ.get("ANTIBROW_GEO_SERVER") or os.environ.get(
        "ANTIBROW_SERVER"
    ) or DEFAULT_GEO_SERVER
    parts = urllib.parse.urlsplit(base.rstrip("/") + "/api/v1/geo")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return [IPAPI_TARGET]
    tls = parts.scheme == "https"
    try:
        port = parts.port or (443 if tls else 80)
    except ValueError:
        return [IPAPI_TARGET]
    return [
        GeoTarget(
            url=urllib.parse.urlunsplit(parts),
            host=parts.hostname,
            port=port,
            path=parts.path + (("?" + parts.query) if parts.query else ""),
            tls=tls,
            kind="own",
        ),
        IPAPI_TARGET,
    ]


def parse_geo_body(target: GeoTarget, body: str) -> Optional[ProxyGeo]:
    """Both endpoints, one shape. None means "try the next target"."""
    return _parse_own_response(body) if target.kind == "own" else parse_geo_response(body)


def _parse_own_response(body: str) -> Optional[ProxyGeo]:
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    # The edge answers 200 with nulls when it has no geo for the caller, and an
    # older deployment answers without an ``ip`` at all. Both have to fall
    # through: no timezone leaves the persona disagreeing with its exit, and no
    # ip turns WebRTC off, which no real browser is.
    if not data.get("timezone") or not data.get("ip"):
        return None
    return ProxyGeo(
        ip=data["ip"],
        country=data.get("countryName") or "",
        timezone=data["timezone"],
        country_code=data.get("countryCode") or data.get("country") or "",
    )


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


def _request_over_socket(
    sock: socket.socket, target: GeoTarget, timeout: float
) -> Optional[ProxyGeo]:
    """Speak HTTP/1.1 on an open tunnel, adding TLS when the target wants it."""
    stream = sock
    if target.tls:
        stream = ssl.create_default_context().wrap_socket(
            sock, server_hostname=target.host
        )
    try:
        stream.settimeout(timeout)
        stream.sendall((
            "GET {0} HTTP/1.1\r\nHost: {1}\r\nAccept: application/json\r\n"
            "User-Agent: antibrow-python\r\nConnection: close\r\n\r\n"
        ).format(target.path, target.host).encode("utf-8"))
        _, body = split_http_response(_read_all(stream))
    finally:
        if stream is not sock:
            try:
                stream.close()
            except OSError:
                pass
    return parse_geo_body(target, body)


def _lookup_via_http_proxy(
    spec: ProxySpec, target: GeoTarget, timeout: float
) -> Optional[ProxyGeo]:
    """Absolute-form GET at the proxy for a plaintext target, CONNECT for a TLS one."""
    port = spec.port or (443 if spec.scheme == "https" else 80)
    sock = socket.create_connection((spec.host, port), timeout=timeout)
    try:
        if spec.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=spec.host)
        if target.tls:
            _proxy_connect(sock, target, spec, timeout)
            return _request_over_socket(sock, target, timeout)

        lines = [
            "GET {0} HTTP/1.1".format(target.url),
            "Host: {0}".format(target.host),
            "Accept: application/json",
            "User-Agent: antibrow-python",
            "Connection: close",
        ]
        if spec.has_credentials:
            lines.append("Proxy-Authorization: " + _basic_auth(spec))
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"))
        _, body = split_http_response(_read_all(sock))
        return parse_geo_body(target, body)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _proxy_connect(
    sock: socket.socket, target: GeoTarget, spec: ProxySpec, timeout: float
) -> None:
    lines = [
        "CONNECT {0}:{1} HTTP/1.1".format(target.host, target.port),
        "Host: {0}:{1}".format(target.host, target.port),
    ]
    if spec.has_credentials:
        lines.append("Proxy-Authorization: " + _basic_auth(spec))
    sock.settimeout(timeout)
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"))

    # Read only the CONNECT status line and headers: anything past the blank
    # line already belongs to the TLS handshake and must stay in the socket.
    raw = b""
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(1)
        if not chunk:
            raise OSError("proxy closed the connection during CONNECT")
        raw += chunk
    status = raw.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    if " 200" not in status:
        raise OSError("proxy refused CONNECT: {0}".format(status))


def _lookup_via_relay(
    spec: ProxySpec, target: GeoTarget, timeout: float
) -> Optional[ProxyGeo]:
    """Managed relay: a normal HTTPS request whose real target is a header.

    Same path the kernel takes (``X-Proxy-Target`` + ``Proxy-Authorization``), so
    the geo we read is the geo the browser will actually exit from.
    """
    port = spec.port or 443
    lines = [
        "GET / HTTP/1.1",
        "Host: {0}".format(spec.host),
        "X-Proxy-Target: {0}".format(target.url),
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


def _lookup_via_socks5(
    spec: ProxySpec, target: GeoTarget, timeout: float
) -> Optional[ProxyGeo]:
    sock = socket.create_connection((spec.host, spec.port or 1080), timeout=timeout)
    try:
        socks5_connect(sock, target.host, target.port, spec.username, spec.password)
        return _request_over_socket(sock, target, timeout)
    finally:
        try:
            sock.close()
        except OSError:
            pass


DIRECT_TIMEOUT = 4.0


def lookup_direct_geo(
    timeout: float = DIRECT_TIMEOUT, server_url: Optional[str] = None
) -> Optional[ProxyGeo]:
    """This machine's own exit, for launches with no proxy.

    The kernel leaves the host IP alone there, so the persona has to agree with
    it: without a public IP WebRTC falls back to being switched off, which no
    real browser is, and the timezone stays on the persona's default while the
    address says otherwise. Short timeout because nothing here blocks a launch -
    a network that swallows the request must not delay every start.
    """
    start = time.monotonic()
    for target in geo_targets(server_url):
        budget = _target_budget(target, timeout, start)
        try:
            request = urllib.request.Request(
                target.url, headers={"User-Agent": USER_AGENT}
            )
            with urllib.request.urlopen(request, timeout=budget) as response:
                body = response.read().decode("utf-8", "replace")
        except Exception:
            continue
        geo = parse_geo_body(target, body)
        if geo is not None:
            geo.rtt_ms = (time.monotonic() - start) * 1000
            return geo
    return None


def _target_budget(target: GeoTarget, timeout: float, start: float) -> float:
    if target.kind == "own":
        return min(timeout, OWN_TARGET_TIMEOUT)
    return max(1.0, timeout - (time.monotonic() - start))


def _lookup_via_relay_tunnel(
    spec: ProxySpec, target: GeoTarget, timeout: float
) -> Optional[ProxyGeo]:
    """Encrypted relays: probe through the same tunnel the browser will use.

    The header path above is the legacy protocol, which a relay only serves
    with plaintext mode switched on - probing over it would make every
    self-hosted deployment choose between a matching timezone and putting
    hostnames in clear text.

    The tunnel writes the HTTP request itself, so it can only carry a plaintext
    target; a TLS one is skipped rather than sent in clear.
    """
    if target.tls:
        raise ValueError("the relay tunnel cannot carry an HTTPS geo target")

    from .relay_tunnel import relay_fetch

    body = relay_fetch(
        spec.to_url(), host=target.host, port=target.port, path=target.path, timeout=timeout
    )
    return parse_geo_body(target, body)


def lookup_proxy_geo(
    proxy: ProxyLike, timeout: float = DEFAULT_TIMEOUT, server_url: Optional[str] = None
) -> Optional[ProxyGeo]:
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

    lookup: Callable[..., Optional[ProxyGeo]]
    if spec.is_relay and spec.relay_key:
        lookup = _lookup_via_relay_tunnel
    elif spec.is_relay:
        lookup = _lookup_via_relay
    elif spec.is_socks:
        lookup = _lookup_via_socks5
    else:
        lookup = _lookup_via_http_proxy

    start = time.monotonic()
    for target in geo_targets(server_url):
        try:
            geo = lookup(spec, target, _target_budget(target, timeout, start))
        except Exception:
            continue
        if geo is not None:
            # Includes DNS, connect and TLS, so it overestimates Chrome's
            # http_rtt - deliberately not compensated: erring slow only yields a
            # slower effectiveType, which is still a self-consistent trio.
            geo.rtt_ms = (time.monotonic() - start) * 1000
            return geo
    return None
