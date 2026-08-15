"""The account's cloud resources: profiles, their state, proxies, the plan.

Everything here talks to the public ``/api/v1/`` surface with an API key, and
everything here raises :class:`~antibrow.errors.ApiError` when the server says
no - these are management calls a caller asked for by name, unlike the
best-effort sync inside a launch (:mod:`antibrow.profile_sync`), which degrades
to "stay local" instead.

The wire format is the Node SDK's, field for field; the dataclasses here just
put snake_case names on it and ignore fields a newer server adds.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from . import _http
from .config import encode_path_segment
from .errors import ApiError

PROFILES_PATH = "/api/v1/profiles"
PROXIES_PATH = "/api/v1/proxies"
PROXY_LIBRARY_PATH = "/api/v1/proxy-library"
ACCOUNT_PATH = "/api/v1/account"

#: Default host for managed ``relay://`` proxies.
DEFAULT_RELAY_HOST = "proxy.antibrow.com"


def _drop_none(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Omit unset fields so a partial update cannot null out server-side ones.

    ``False`` and ``0`` are kept: ``canvas_noise=False`` is a real value.
    """
    return {key: value for key, value in raw.items() if value is not None}


def _call(
    method: str,
    url: str,
    api_key: str,
    *,
    payload: Any = None,
    action: str = "request",
    allow: Sequence[int] = (200, 201),
) -> Any:
    """Send an authenticated JSON call, raising unless the status is allowed."""
    status, text = _http.send(method, url, api_key=api_key, payload=payload)
    if status not in allow:
        raise ApiError.of(status, text, action)
    return _http.parse_json(text)


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _as_int(value: Any, fallback: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else fallback


# -- profiles ---------------------------------------------------------------


@dataclass(frozen=True)
class ProxyRef:
    """Which proxy a profile uses, by reference. Managed proxies expose only an
    id; the exit endpoint never leaves the server."""

    kind: str  # "managed" | "local"
    managed_proxy_id: Optional[str] = None
    local_proxy_id: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "Optional[ProxyRef]":
        raw = _as_dict(raw)
        kind = raw.get("kind")
        if kind not in ("managed", "local"):
            return None
        return cls(
            kind=kind,
            managed_proxy_id=_as_str(raw.get("managedProxyId")),
            local_proxy_id=_as_str(raw.get("localProxyId")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return _drop_none(
            {
                "kind": self.kind,
                "managedProxyId": self.managed_proxy_id,
                "localProxyId": self.local_proxy_id,
            }
        )


@dataclass(frozen=True)
class ProfileConfig:
    """A profile's portable settings. The identity (persona) stays local; this
    is what every machine has to agree on before the profile is ever opened."""

    group: Optional[str] = None
    label: Optional[str] = None
    color: Optional[str] = None
    note: Optional[str] = None
    tags: Optional[List[str]] = None
    proxy: Optional[ProxyRef] = None
    canvas_noise: Optional[bool] = None
    api_log: Optional[str] = None  # "off" | "curated" | "all"
    webauthn_capture: Optional[bool] = None
    device_type: Optional[str] = None  # "desktop" | "android"
    real_fingerprint: Optional[bool] = None
    kernel_version: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "Optional[ProfileConfig]":
        if not isinstance(raw, dict):
            return None
        tags = raw.get("tags")
        return cls(
            group=_as_str(raw.get("group")),
            label=_as_str(raw.get("label")),
            color=_as_str(raw.get("color")),
            note=_as_str(raw.get("note")),
            tags=[t for t in tags if isinstance(t, str)] if isinstance(tags, list) else None,
            proxy=ProxyRef.from_dict(raw.get("proxy")),
            canvas_noise=raw.get("canvasNoise") if isinstance(raw.get("canvasNoise"), bool) else None,
            api_log=_as_str(raw.get("apiLog")),
            webauthn_capture=raw.get("webauthnCapture") if isinstance(raw.get("webauthnCapture"), bool) else None,
            device_type=_as_str(raw.get("deviceType")),
            real_fingerprint=raw.get("realFingerprint") if isinstance(raw.get("realFingerprint"), bool) else None,
            kernel_version=_as_str(raw.get("kernelVersion")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return _drop_none(
            {
                "group": self.group,
                "label": self.label,
                "color": self.color,
                "note": self.note,
                "tags": list(self.tags) if self.tags is not None else None,
                "proxy": self.proxy.to_dict() if self.proxy is not None else None,
                "canvasNoise": self.canvas_noise,
                "apiLog": self.api_log,
                "webauthnCapture": self.webauthn_capture,
                "deviceType": self.device_type,
                "realFingerprint": self.real_fingerprint,
                "kernelVersion": self.kernel_version,
            }
        )


@dataclass(frozen=True)
class SyncedProfile:
    id: str
    name: str
    config: Optional[ProfileConfig] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    #: Set on a profile the server has deleted; a delta pull reports it so the
    #: client can drop its own copy.
    deleted_at: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "SyncedProfile":
        raw = _as_dict(raw)
        return cls(
            id=_as_str(raw.get("id")) or "",
            name=_as_str(raw.get("name")) or "",
            config=ProfileConfig.from_dict(raw.get("config")),
            created_at=_as_str(raw.get("createdAt")),
            updated_at=_as_str(raw.get("updatedAt")),
            deleted_at=_as_str(raw.get("deletedAt")),
        )


@dataclass(frozen=True)
class ProfileSyncPage:
    """Delta-pull envelope. ``server_time`` is what to pass as the next
    ``since``, so use the server's clock rather than the local one."""

    profiles: List[SyncedProfile] = field(default_factory=list)
    server_time: str = ""


def create_profile(
    api_key: str,
    server: Optional[str] = None,
    *,
    name: str,
    tags: Optional[Sequence[str]] = None,
    id: Optional[str] = None,
    config: Optional[ProfileConfig] = None,
) -> SyncedProfile:
    payload = _drop_none(
        {
            "id": id,
            "name": name,
            "tags": list(tags) if tags is not None else None,
            "config": config.to_dict() if config is not None else None,
        }
    )
    body = _call("POST", _http.url_for(server, PROFILES_PATH), api_key, payload=payload, action="create profile")
    return SyncedProfile.from_dict(body)


def update_profile(
    api_key: str,
    server: Optional[str] = None,
    *,
    id: str,
    name: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
    config: Optional[ProfileConfig] = None,
) -> SyncedProfile:
    """``id`` addresses the profile and may be its id or its name."""
    payload = _drop_none(
        {
            "name": name,
            "tags": list(tags) if tags is not None else None,
            "config": config.to_dict() if config is not None else None,
        }
    )
    url = _http.url_for(server, "{0}/{1}".format(PROFILES_PATH, encode_path_segment(id)))
    return SyncedProfile.from_dict(_call("PUT", url, api_key, payload=payload, action="update profile"))


def get_profile(api_key: str, server: Optional[str] = None, *, name: str) -> SyncedProfile:
    url = _http.url_for(server, "{0}/{1}".format(PROFILES_PATH, encode_path_segment(name)))
    return SyncedProfile.from_dict(_call("GET", url, api_key, action="get profile"))


def get_or_create_profile(
    api_key: str,
    server: Optional[str] = None,
    *,
    name: str,
    tags: Optional[Sequence[str]] = None,
    id: Optional[str] = None,
    config: Optional[ProfileConfig] = None,
) -> SyncedProfile:
    """Fetch the profile, creating it when the server has never seen the name.

    A 409 on the create means another process won the race, so the second read
    is the answer rather than an error.
    """
    try:
        return get_profile(api_key, server, name=name)
    except ApiError as error:
        if error.status != 404:
            raise
    try:
        return create_profile(api_key, server, name=name, tags=tags, id=id, config=config)
    except ApiError as error:
        if error.status != 409:
            raise
    return get_profile(api_key, server, name=name)


def sync_pull_profiles(
    api_key: str, server: Optional[str] = None, *, since: Optional[str] = None
) -> ProfileSyncPage:
    """Every profile, or only those changed since a previous page's
    ``server_time``. Deleted ones come back carrying ``deleted_at``."""
    url = _http.url_for(server, PROFILES_PATH, {"since": since} if since else None)
    body = _as_dict(_call("GET", url, api_key, action="pull profiles"))
    raw = body.get("profiles")
    return ProfileSyncPage(
        profiles=[SyncedProfile.from_dict(p) for p in raw] if isinstance(raw, list) else [],
        server_time=_as_str(body.get("serverTime")) or "",
    )


def list_server_profiles(api_key: str, server: Optional[str] = None) -> List[SyncedProfile]:
    """Every cloud profile on this account."""
    return sync_pull_profiles(api_key, server).profiles


def delete_profile(
    api_key: str, server: Optional[str] = None, *, id: Optional[str] = None, name: Optional[str] = None
) -> None:
    ident = id or name
    if not ident:
        raise ValueError("delete_profile requires an id or a name")
    url = _http.url_for(server, "{0}/{1}".format(PROFILES_PATH, encode_path_segment(ident)))
    _call("DELETE", url, api_key, action="delete profile", allow=(200, 201, 204))


@dataclass(frozen=True)
class LaunchProfile:
    """What ``launch()`` needs to open a cloud profile on this machine."""

    #: Pass as ``launch(profile=...)``.
    profile: str
    #: Pass as ``launch(proxy_id=...)``.
    proxy_id: Optional[str] = None
    #: A resolved URL for a profile bound to one of your own proxies; pass as
    #: ``launch(proxy=...)``.
    proxy: Optional[str] = None


def get_profile_for_launch(
    api_key: str, server: Optional[str] = None, *, id: Optional[str] = None, name: Optional[str] = None
) -> LaunchProfile:
    """Resolve a cloud profile into launch arguments, following its proxy
    reference into the proxy library when it points at one of your own."""
    ident = id or name
    if not ident:
        raise ValueError("get_profile_for_launch requires an id or a name")
    url = _http.url_for(server, "{0}/{1}".format(PROFILES_PATH, encode_path_segment(ident)))
    synced = SyncedProfile.from_dict(_call("GET", url, api_key, action="fetch profile for launch"))
    if not synced.name:
        raise ApiError('Invalid profile response: missing "name"', status=200)

    ref = synced.config.proxy if synced.config else None
    if ref is None:
        return LaunchProfile(profile=synced.name)
    if ref.kind == "managed":
        return LaunchProfile(profile=synced.name, proxy_id=ref.managed_proxy_id)

    page = sync_pull_user_proxies(api_key, server)
    found = next((p for p in page.proxies if p.id == ref.local_proxy_id and p.config), None)
    return LaunchProfile(
        profile=synced.name,
        proxy=proxy_config_to_url(found.config) if found and found.config else None,
    )


# -- profile state ----------------------------------------------------------


@dataclass(frozen=True)
class ProfileStateCookie:
    name: str
    value: str
    domain: Optional[str] = None
    path: Optional[str] = None
    expires: Optional[float] = None
    http_only: Optional[bool] = None
    secure: Optional[bool] = None
    same_site: Optional[str] = None  # "Strict" | "Lax" | "None"

    @classmethod
    def from_dict(cls, raw: Any) -> "ProfileStateCookie":
        raw = _as_dict(raw)
        expires = raw.get("expires")
        return cls(
            name=_as_str(raw.get("name")) or "",
            value=_as_str(raw.get("value")) or "",
            domain=_as_str(raw.get("domain")),
            path=_as_str(raw.get("path")),
            expires=float(expires) if isinstance(expires, (int, float)) and not isinstance(expires, bool) else None,
            http_only=raw.get("httpOnly") if isinstance(raw.get("httpOnly"), bool) else None,
            secure=raw.get("secure") if isinstance(raw.get("secure"), bool) else None,
            same_site=_as_str(raw.get("sameSite")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return _drop_none(
            {
                "name": self.name,
                "value": self.value,
                "domain": self.domain,
                "path": self.path,
                "expires": self.expires,
                "httpOnly": self.http_only,
                "secure": self.secure,
                "sameSite": self.same_site,
            }
        )


@dataclass(frozen=True)
class ProfileStateOrigin:
    origin: str
    local_storage: List[Dict[str, str]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: Any) -> "ProfileStateOrigin":
        raw = _as_dict(raw)
        items = raw.get("localStorage")
        return cls(
            origin=_as_str(raw.get("origin")) or "",
            local_storage=[i for i in items if isinstance(i, dict)] if isinstance(items, list) else [],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {"origin": self.origin, "localStorage": list(self.local_storage)}


@dataclass(frozen=True)
class ProfileState:
    """Cookies and storage as plain values.

    A different thing from the profile archive: the archive is the browser's own
    binary state, this is a portable snapshot you can read, edit and replay into
    another browser.
    """

    cookies: List[ProfileStateCookie] = field(default_factory=list)
    origins: List[ProfileStateOrigin] = field(default_factory=list)
    tabs: List[str] = field(default_factory=list)
    permissions: Optional[Dict[str, Any]] = None
    service_workers: Optional[str] = None
    updated_at: Optional[str] = None


def _state_url(server: Optional[str], name: str) -> str:
    return _http.url_for(server, "{0}/{1}/state".format(PROFILES_PATH, encode_path_segment(name)))


def upload_profile_state(
    api_key: str,
    server: Optional[str] = None,
    *,
    name: str,
    cookies: Sequence[ProfileStateCookie],
    origins: Optional[Sequence[ProfileStateOrigin]] = None,
    tabs: Optional[Sequence[str]] = None,
    permissions: Optional[Dict[str, Any]] = None,
    service_workers: Optional[str] = None,
) -> None:
    body = _as_dict(_call("POST", _state_url(server, name), api_key, action="get state upload URL"))
    upload_url = _as_str(body.get("uploadUrl"))
    if not upload_url:
        raise ApiError("State upload URL was missing from the response", status=200)

    payload = {
        "cookies": [c.to_dict() for c in cookies],
        "origins": [o.to_dict() for o in (origins or [])],
        "tabs": list(tabs or []),
        "permissions": permissions,
        "serviceWorkers": service_workers,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    # The presigned URL authenticates itself; sending the API key to storage
    # would put it somewhere it has no business being.
    status, text = _http.send("PUT", upload_url, payload=payload)
    if status not in (200, 201, 204):
        raise ApiError.of(status, text, "upload profile state")


def download_profile_state(
    api_key: str, server: Optional[str] = None, *, name: str
) -> Optional[ProfileState]:
    """The stored state, or ``None`` when this profile has never uploaded one."""
    status, text = _http.send("GET", _state_url(server, name), api_key=api_key)
    if status == 404:
        return None
    if status != 200:
        raise ApiError.of(status, text, "get state download URL")
    download_url = _as_str(_as_dict(_http.parse_json(text)).get("downloadUrl"))
    if not download_url:
        return None

    status, text = _http.send("GET", download_url)
    # Storage answers 403 for an object that is not there.
    if status in (403, 404):
        return None
    if status != 200:
        raise ApiError.of(status, text, "download profile state")

    raw = _as_dict(_http.parse_json(text))
    cookies = raw.get("cookies")
    origins = raw.get("origins")
    tabs = raw.get("tabs")
    return ProfileState(
        cookies=[ProfileStateCookie.from_dict(c) for c in cookies] if isinstance(cookies, list) else [],
        origins=[ProfileStateOrigin.from_dict(o) for o in origins] if isinstance(origins, list) else [],
        tabs=[t for t in tabs if isinstance(t, str)] if isinstance(tabs, list) else [],
        permissions=raw.get("permissions") if isinstance(raw.get("permissions"), dict) else None,
        service_workers=_as_str(raw.get("serviceWorkers")),
        updated_at=_as_str(raw.get("updatedAt")),
    )


# -- managed proxies --------------------------------------------------------


@dataclass(frozen=True)
class ManagedProxy:
    """A proxy the service holds for you. The upstream endpoint stays
    server-side; a client only ever sees the id."""

    id: str
    protocol: str = ""
    status: Optional[str] = None
    display_name: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "Optional[ManagedProxy]":
        raw = _as_dict(raw)
        pid = _as_str(raw.get("id"))
        if not pid:
            return None
        return cls(
            id=pid,
            protocol=_as_str(raw.get("protocol")) or "",
            status=_as_str(raw.get("status")),
            display_name=_as_str(raw.get("displayName")),
        )


@dataclass(frozen=True)
class ProxyQuota:
    limit: int = 0
    used_this_month: int = 0
    remaining: int = 0
    hold_count: int = 0
    hold_cap: int = 0

    @classmethod
    def from_dict(cls, raw: Any) -> "Optional[ProxyQuota]":
        if not isinstance(raw, dict):
            return None
        return cls(
            limit=_as_int(raw.get("limit")),
            used_this_month=_as_int(raw.get("usedThisMonth")),
            remaining=_as_int(raw.get("remaining")),
            hold_count=_as_int(raw.get("holdCount")),
            hold_cap=_as_int(raw.get("holdCap")),
        )


@dataclass(frozen=True)
class ProxyListing:
    proxies: List[ManagedProxy] = field(default_factory=list)
    quota: Optional[ProxyQuota] = None


@dataclass(frozen=True)
class ProxyActivation:
    allowed: bool = True
    proxy: Optional[ManagedProxy] = None
    quota: Optional[ProxyQuota] = None


@dataclass(frozen=True)
class ProxyTicket:
    """Short-lived credentials for one managed proxy."""

    ticket_id: str
    username: str
    password: str
    host: str
    expires_at: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "ProxyTicket":
        raw = _as_dict(raw)
        return cls(
            ticket_id=_as_str(raw.get("ticketId")) or "",
            username=_as_str(raw.get("username")) or "",
            password=_as_str(raw.get("password")) or "",
            host=_as_str(raw.get("host")) or "",
            expires_at=_as_str(raw.get("expiresAt")),
        )


def managed_proxy_to_relay_url(
    username: str, ticket_secret: str, host: str = DEFAULT_RELAY_HOST
) -> str:
    """``relay://<user>:<ticket>@<host>`` for the kernel's ``--proxy-server``.

    The exit endpoint is resolved server-side, and the credential is a
    short-lived ticket rather than the account key - which would otherwise sit
    in the process command line for anyone on the machine to read.
    """
    return "relay://{0}:{1}@{2}".format(
        urllib.parse.quote(username, safe=""), urllib.parse.quote(ticket_secret, safe=""), host
    )


def list_proxies(api_key: str, server: Optional[str] = None) -> ProxyListing:
    body = _as_dict(_call("GET", _http.url_for(server, PROXIES_PATH), api_key, action="list proxies"))
    raw = body.get("proxies")
    return ProxyListing(
        proxies=[p for p in (ManagedProxy.from_dict(x) for x in raw) if p] if isinstance(raw, list) else [],
        quota=ProxyQuota.from_dict(body.get("quota")),
    )


def _proxy_action(api_key: str, server: Optional[str], body: Dict[str, Any]) -> Dict[str, Any]:
    result = _call(
        "POST",
        _http.url_for(server, PROXIES_PATH),
        api_key,
        payload=body,
        action="proxy {0}".format(body.get("action")),
    )
    return _as_dict(result)


def claim_managed_proxy(api_key: str, server: Optional[str] = None) -> Optional[ManagedProxy]:
    """Take a proxy from the pool and hold it for this account."""
    return ManagedProxy.from_dict(_proxy_action(api_key, server, {"action": "claim"}).get("proxy"))


def release_managed_proxy(api_key: str, server: Optional[str] = None, *, proxy_id: str) -> None:
    _proxy_action(api_key, server, {"action": "release", "proxyId": proxy_id})


def swap_managed_proxy(
    api_key: str, server: Optional[str] = None, *, proxy_id: str
) -> Optional[ManagedProxy]:
    """Trade a held proxy for a different one."""
    return ManagedProxy.from_dict(
        _proxy_action(api_key, server, {"action": "swap", "proxyId": proxy_id}).get("proxy")
    )


def _reject_proxy_access(status: int, text: str) -> None:
    """The two answers shared by every plan-gated proxy route."""
    if status == 403:
        raise ApiError(
            "Proxy monthly quota exceeded for your plan. Upgrade, or stop using another proxy this month.",
            status=403,
        )
    if status == 404 and "not_your_proxy" in text:
        raise ApiError("Proxy not found, or it does not belong to you.", status=404)


def activate_proxy(api_key: str, server: Optional[str] = None, *, proxy_id: str) -> ProxyActivation:
    """Meter and authorise one use of a managed proxy. Call before taking a
    ticket: this is what checks ownership and the monthly quota."""
    url = _http.url_for(server, "{0}/{1}/activate".format(PROXIES_PATH, encode_path_segment(proxy_id)))
    status, text = _http.send("POST", url, api_key=api_key)
    _reject_proxy_access(status, text)
    if status not in (200, 201):
        raise ApiError.of(status, text, "activate proxy")
    body = _as_dict(_http.parse_json(text))
    allowed = body.get("allowed")
    return ProxyActivation(
        allowed=allowed if isinstance(allowed, bool) else True,
        proxy=ManagedProxy.from_dict(body.get("proxy")),
        quota=ProxyQuota.from_dict(body.get("quota")),
    )


def issue_proxy_ticket(
    api_key: str,
    server: Optional[str] = None,
    *,
    proxy_id: str,
    label: Optional[str] = None,
    ttl_minutes: Optional[int] = None,
) -> ProxyTicket:
    url = _http.url_for(server, "{0}/{1}/ticket".format(PROXIES_PATH, encode_path_segment(proxy_id)))
    payload = _drop_none({"label": label, "ttlMinutes": ttl_minutes})
    status, text = _http.send("POST", url, api_key=api_key, payload=payload)
    # A deployed route answers 404 only with `not_your_proxy`. A bare 404 means
    # the endpoint is not there at all (server not updated, or rolled back), and
    # calling that "proxy not found" sends whoever debugs it down the wrong path.
    if status == 404 and "not_your_proxy" not in text:
        raise ApiError(
            "Proxy ticket endpoint not found (HTTP 404). This server does not support managed "
            "proxy tickets - upgrade the server, or pin an older SDK.",
            status=404,
        )
    _reject_proxy_access(status, text)
    if status not in (200, 201):
        raise ApiError.of(status, text, "issue proxy ticket")
    return ProxyTicket.from_dict(_http.parse_json(text))


def revoke_proxy_ticket(
    api_key: str, server: Optional[str] = None, *, proxy_id: str, ticket_id: str
) -> None:
    """Best-effort: a ticket expires on its own, so a failed revoke is never
    fatal and never raises."""
    url = _http.url_for(
        server,
        "{0}/{1}/ticket".format(PROXIES_PATH, encode_path_segment(proxy_id)),
        {"ticketId": ticket_id},
    )
    _http.send("DELETE", url, api_key=api_key)


# -- your own proxies -------------------------------------------------------


@dataclass(frozen=True)
class ProxyConfig:
    """One of your own proxies, credentials included - unlike a managed one."""

    type: str  # "SOCKS5" | "HTTP" | "SSH"
    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    label: Optional[str] = None
    country: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "Optional[ProxyConfig]":
        if not isinstance(raw, dict):
            return None
        host = _as_str(raw.get("host"))
        if not host:
            return None
        return cls(
            type=_as_str(raw.get("type")) or "HTTP",
            host=host,
            port=_as_int(raw.get("port")),
            username=_as_str(raw.get("username")),
            password=_as_str(raw.get("password")),
            label=_as_str(raw.get("label")),
            country=_as_str(raw.get("country")),
        )

    def to_dict(self) -> Dict[str, Any]:
        return _drop_none(
            {
                "type": self.type,
                "host": self.host,
                "port": self.port,
                "username": self.username,
                "password": self.password,
                "label": self.label,
                "country": self.country,
            }
        )


@dataclass(frozen=True)
class SyncedProxy:
    id: str
    config: Optional[ProxyConfig] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Any) -> "SyncedProxy":
        raw = _as_dict(raw)
        return cls(
            id=_as_str(raw.get("id")) or "",
            config=ProxyConfig.from_dict(raw.get("config")),
            created_at=_as_str(raw.get("createdAt")),
            updated_at=_as_str(raw.get("updatedAt")),
            deleted_at=_as_str(raw.get("deletedAt")),
        )


@dataclass(frozen=True)
class ProxySyncPage:
    proxies: List[SyncedProxy] = field(default_factory=list)
    server_time: str = ""


def proxy_config_to_url(config: ProxyConfig) -> str:
    """The URL form ``launch(proxy=...)`` takes."""
    scheme = {"SOCKS5": "socks5", "SSH": "ssh"}.get(config.type.upper(), "http")
    auth = ""
    if config.username:
        auth = "{0}:{1}@".format(
            urllib.parse.quote(config.username, safe=""),
            urllib.parse.quote(config.password or "", safe=""),
        )
    return "{0}://{1}{2}:{3}".format(scheme, auth, config.host, config.port)


def create_user_proxy(
    api_key: str, server: Optional[str] = None, *, config: ProxyConfig, id: Optional[str] = None
) -> SyncedProxy:
    payload = _drop_none({"id": id, "config": config.to_dict()})
    body = _call(
        "POST", _http.url_for(server, PROXY_LIBRARY_PATH), api_key, payload=payload, action="create proxy"
    )
    return SyncedProxy.from_dict(body)


def update_user_proxy(
    api_key: str, server: Optional[str] = None, *, id: str, config: ProxyConfig
) -> SyncedProxy:
    url = _http.url_for(server, "{0}/{1}".format(PROXY_LIBRARY_PATH, encode_path_segment(id)))
    body = _call("PUT", url, api_key, payload={"config": config.to_dict()}, action="update proxy")
    return SyncedProxy.from_dict(body)


def delete_user_proxy(api_key: str, server: Optional[str] = None, *, id: str) -> None:
    url = _http.url_for(server, "{0}/{1}".format(PROXY_LIBRARY_PATH, encode_path_segment(id)))
    _call("DELETE", url, api_key, action="delete proxy", allow=(200, 201, 204))


def sync_pull_user_proxies(
    api_key: str, server: Optional[str] = None, *, since: Optional[str] = None
) -> ProxySyncPage:
    url = _http.url_for(server, PROXY_LIBRARY_PATH, {"since": since} if since else None)
    body = _as_dict(_call("GET", url, api_key, action="pull proxies"))
    raw = body.get("proxies")
    return ProxySyncPage(
        proxies=[SyncedProxy.from_dict(p) for p in raw] if isinstance(raw, list) else [],
        server_time=_as_str(body.get("serverTime")) or "",
    )


def list_user_proxies(api_key: str, server: Optional[str] = None) -> List[SyncedProxy]:
    """Every proxy in your own library."""
    return sync_pull_user_proxies(api_key, server).proxies


# -- account ----------------------------------------------------------------


@dataclass(frozen=True)
class AccountInfo:
    email: str = ""
    plan: str = ""
    expires_at: Optional[str] = None
    #: Max simultaneous browser instances (the license token's ``mi``).
    concurrency: int = 0
    #: Whether cloud profile sync is available. Local profiles are unlimited
    #: regardless.
    sync_enabled: bool = False
    profile_limit: int = 0
    profile_count: int = 0
    profile_remaining: int = 0


def get_account(api_key: str, server: Optional[str] = None) -> AccountInfo:
    """Plan, quota and concurrency for this API key."""
    raw = _as_dict(_call("GET", _http.url_for(server, ACCOUNT_PATH), api_key, action="get account"))
    return AccountInfo(
        email=_as_str(raw.get("email")) or "",
        plan=_as_str(raw.get("plan")) or "",
        expires_at=_as_str(raw.get("expiresAt")),
        concurrency=_as_int(raw.get("concurrency")),
        sync_enabled=raw.get("syncEnabled") is True,
        profile_limit=_as_int(raw.get("profileLimit")),
        profile_count=_as_int(raw.get("profileCount")),
        profile_remaining=_as_int(raw.get("profileRemaining")),
    )
