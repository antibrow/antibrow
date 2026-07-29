"""Proxy parsing and the ``--proxy-server`` switch.

The kernel handles proxy credentials itself: one switch, credentials inline,
all four schemes.

===========  ============================  ==============================
scheme       transport                     authentication
===========  ============================  ==============================
``http``     HTTP proxy                    407 answered in the network stack
``https``    HTTPS proxy                   407 answered in the network stack
``socks5``   SOCKS5                        RFC 1929 user/pass sub-negotiation
``relay``    AntiBrow managed relay        ``Proxy-Authorization: Basic``
===========  ============================  ==============================

That is why ``proxy_auth="native"`` is the default: nothing shows up in
``chrome://extensions``, which is exactly the kind of tell an antidetect browser
must not have. ``proxy_auth="extension"`` reproduces the older MV3
``onAuthRequired`` scheme still used by the Node SDK; it exists as an escape
hatch for HTTP/HTTPS proxies if you ever run a kernel build that predates the
0004 patch.
"""

from __future__ import annotations

import json
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Union

from .errors import ProxyError

#: Schemes the kernel understands on ``--proxy-server``.
SUPPORTED_SCHEMES = ("http", "https", "socks5", "socks", "relay")

ProxyLike = Union[str, Mapping[str, Any], "ProxySpec", None]


@dataclass
class ProxySpec:
    """A parsed proxy definition."""

    scheme: str
    host: str
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None

    @property
    def has_credentials(self) -> bool:
        return bool(self.username)

    @property
    def is_socks(self) -> bool:
        return self.scheme in ("socks5", "socks")

    @property
    def is_relay(self) -> bool:
        return self.scheme == "relay"

    @property
    def netloc(self) -> str:
        return "{0}:{1}".format(self.host, self.port) if self.port else self.host

    def to_url(self, *, with_credentials: bool = True) -> str:
        """Rebuild the URL, optionally without the credentials."""
        if with_credentials and self.username:
            userinfo = urllib.parse.quote(self.username, safe="")
            if self.password:
                userinfo += ":" + urllib.parse.quote(self.password, safe="")
            return "{0}://{1}@{2}".format(self.scheme, userinfo, self.netloc)
        return "{0}://{1}".format(self.scheme, self.netloc)

    def __str__(self) -> str:  # never leak the password in logs / reprs
        return self.to_url(with_credentials=False)


def parse_proxy(proxy: ProxyLike) -> Optional[ProxySpec]:
    """Normalise a proxy into a :class:`ProxySpec`.

    Accepts a URL string (``http://user:pass@host:port``) or a Playwright-style
    mapping (``{"server": ..., "username": ..., "password": ...}``) so existing
    Playwright code can be moved over unchanged.
    """
    if proxy is None:
        return None
    if isinstance(proxy, ProxySpec):
        return proxy
    if isinstance(proxy, Mapping):
        server = proxy.get("server") or proxy.get("url") or proxy.get("host")
        if not server:
            raise ProxyError('Proxy mapping needs a "server" key, e.g. {"server": "http://host:8080"}')
        spec = _parse_proxy_url(str(server))
        username = proxy.get("username")
        password = proxy.get("password")
        if username:
            spec.username = str(username)
            spec.password = str(password) if password is not None else None
        return spec
    if isinstance(proxy, str):
        return _parse_proxy_url(proxy)
    raise ProxyError("Unsupported proxy value: {0!r}".format(proxy))


def _parse_proxy_url(url: str) -> ProxySpec:
    raw = url.strip()
    if not raw:
        raise ProxyError("Empty proxy URL")
    if "://" not in raw:
        # Bare "host:port" is a common shorthand; assume the usual HTTP proxy.
        raw = "http://" + raw
    parsed = urllib.parse.urlsplit(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in SUPPORTED_SCHEMES:
        raise ProxyError(
            'Unsupported proxy scheme "{0}". Use one of: {1}'.format(
                scheme, ", ".join(SUPPORTED_SCHEMES)
            )
        )
    if not parsed.hostname or any(c.isspace() for c in parsed.hostname):
        raise ProxyError("Proxy URL has no usable host: {0!r}".format(url))
    return ProxySpec(
        scheme=scheme,
        host=parsed.hostname,
        port=parsed.port,
        # urlsplit keeps userinfo percent-encoded; the kernel wants it raw, and
        # passwords with "@" or ":" are common in residential proxy pools.
        username=urllib.parse.unquote(parsed.username) if parsed.username else None,
        password=urllib.parse.unquote(parsed.password) if parsed.password else None,
    )


def write_proxy_auth_extension(profile_dir: Path | str, username: str, password: str) -> Path:
    """Write the MV3 fallback extension that answers ``onAuthRequired``.

    Only used with ``proxy_auth="extension"``. It is visible in
    ``chrome://extensions``, so prefer the native path.
    """
    ext_dir = Path(profile_dir) / "proxy-auth-ext"
    ext_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "name": "Proxy Auth",
        "version": "1.0.0",
        "manifest_version": 3,
        "permissions": ["webRequest", "webRequestAuthProvider"],
        "host_permissions": ["<all_urls>"],
        "background": {"service_worker": "background.js"},
    }
    (ext_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    background = "\n".join(
        [
            "const USERNAME = {0};".format(json.dumps(username)),
            "const PASSWORD = {0};".format(json.dumps(password or "")),
            "chrome.webRequest.onAuthRequired.addListener(",
            "  (details, callback) => {",
            "    if (!details.isProxy) { callback({}); return; }",
            "    callback({ authCredentials: { username: USERNAME, password: PASSWORD } });",
            "  },",
            "  { urls: ['<all_urls>'] },",
            "  ['asyncBlocking']",
            ");",
        ]
    )
    (ext_dir / "background.js").write_text(background, encoding="utf-8")
    return ext_dir


def proxy_args(
    spec: Optional[ProxySpec],
    *,
    profile_dir: Path | str,
    mode: str = "native",
) -> list:
    """Build the ``--proxy-server`` (and, in extension mode, extension) switches."""
    if spec is None:
        return []
    if mode not in ("native", "extension"):
        raise ProxyError('proxy_auth must be "native" or "extension", got {0!r}'.format(mode))

    if mode == "native" or not spec.has_credentials or spec.is_relay:
        # relay:// always carries its credentials inline - that is the protocol.
        return ["--proxy-server={0}".format(spec.to_url())]

    if spec.is_socks:
        raise ProxyError(
            "proxy_auth='extension' cannot authenticate SOCKS5 (Chrome's extension "
            "auth API only covers HTTP proxies). Use the default proxy_auth='native', "
            "which authenticates SOCKS5 in the kernel via RFC 1929."
        )
    ext_dir = write_proxy_auth_extension(profile_dir, spec.username or "", spec.password or "")
    return [
        "--proxy-server={0}".format(spec.to_url(with_credentials=False)),
        "--disable-extensions-except={0}".format(ext_dir),
        "--load-extension={0}".format(ext_dir),
    ]


def redact(proxy: ProxyLike) -> Optional[str]:
    """Credential-free description of a proxy, safe to log."""
    spec = parse_proxy(proxy)
    return None if spec is None else spec.to_url(with_credentials=False)
