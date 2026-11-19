"""With a custom server, the only antibrow host the SDK may touch is the download site."""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import pytest

from antibrow import api as A
from antibrow import browser as B
from antibrow import devices as D
from antibrow import kernel as K
from antibrow import liveview as LV
from antibrow.geoip import lookup_direct_geo
from antibrow.license import fetch_license_token
from antibrow.recipe import fanout_recipe, load_registry
from antibrow.server_config import FeatureUnavailableError

SERVER = "https://api.acme.com"
ALLOWED = {"api.acme.com", "download.antibrow.com", "ip-api.com"}
OEM_CONFIG = {
    "brand": {"name": "Acme Browser", "logoUrl": "", "accent": "", "links": {"website": "https://acme.com", "docs": "", "upgrade": "", "support": ""}},
    "kernelManifestUrl": "https://download.antibrow.com/fp-browser-versions.json",
    "appVersionsUrl": "https://api.acme.com/api/v1/app-versions",
    "recipeRegistryUrl": "",
    "features": {"cloudSync": True, "team": False, "share": False, "managedProxy": False, "liveView": False, "realDevices": False, "emailLogin": False},
}


class _Seen(list):
    state: dict


class _Response(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def hosts(monkeypatch, tmp_path):
    seen = _Seen()
    state = {"config_status": 200}
    monkeypatch.setenv("ANTIBROW_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("ANTIBROW_RECIPES_URL", raising=False)
    monkeypatch.delenv("ANTIBROW_SERVER", raising=False)
    monkeypatch.delenv("ANTI_DETECT_BROWSER_SERVER", raising=False)

    def fake_urlopen(request, timeout=None, **kwargs):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        parts = urlsplit(url)
        seen.append(parts.hostname)
        if parts.hostname == "api.acme.com" and parts.path == "/api/v1/config":
            if state["config_status"] != 200:
                raise urllib.error.HTTPError(url, state["config_status"], "nope", {}, io.BytesIO(b"{}"))
            return _Response(json.dumps(OEM_CONFIG).encode("utf-8"))
        if parts.hostname == "api.acme.com" and parts.path == "/api/v1/engine/token":
            return _Response(json.dumps({"token": "e30.sig", "exp": 4102444800, "mi": 2, "sync": True}).encode("utf-8"))
        if parts.hostname == "api.acme.com" and parts.path == "/api/v1/profiles":
            return _Response(b'{"profiles": [], "serverTime": "2026-01-01T00:00:00Z"}')
        if parts.hostname == "download.antibrow.com":
            return _Response(b'{"versions": []}')
        if parts.hostname == "ip-api.com":
            return _Response(b'{"status":"success","countryCode":"US","timezone":"America/New_York"}')
        return _Response(b"{}")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    seen.state = state
    return seen


def _exercise(tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    fetch_license_token("adb_x", SERVER)
    K.refresh_kernel_versions(cache, force=True, server=SERVER)
    lookup_direct_geo(server_url=SERVER)
    A.list_server_profiles("adb_x", SERVER)

    with pytest.raises(FeatureUnavailableError):
        B.prepare_launch("p1", proxy_id="px1", api_key="adb_x", server=SERVER, cache_dir=cache, focus_window=False)
    with pytest.raises(FeatureUnavailableError):
        B._assert_live_view_available(True, None, SERVER, cache)
    with pytest.raises(FeatureUnavailableError):
        LV.register_live_session("adb_x", SERVER, session_key="s1", cache_dir=str(cache))
    with pytest.raises(FeatureUnavailableError):
        A.list_proxies("adb_x", SERVER)
    with pytest.raises(FeatureUnavailableError):
        A.claim_managed_proxy("adb_x", SERVER)
    with pytest.raises(FeatureUnavailableError):
        D.fetch_real_device("windows", "adb_x", SERVER, str(cache))
    with pytest.raises(FeatureUnavailableError):
        load_registry(cache, SERVER)
    with pytest.raises(FeatureUnavailableError):
        fanout_recipe("a/b", ["p1"], api_key="adb_x", server=SERVER, cache_dir=cache)


def test_custom_server_never_reaches_antibrow_business_hosts(hosts, tmp_path):
    _exercise(tmp_path)
    assert "api.acme.com" in hosts
    assert [h for h in hosts if h not in ALLOWED] == []


def test_config_failure_never_falls_back_to_antibrow_business_hosts(hosts, tmp_path):
    hosts.state["config_status"] = 404
    _exercise(tmp_path)
    assert [h for h in hosts if h not in ALLOWED] == []


@pytest.fixture
def prep(monkeypatch, tmp_path):
    """prepare_launch with the kernel and license faked; geo and everything else is real."""
    from antibrow import geoip as G
    from antibrow import kernel as KK
    from antibrow import license as L

    exe = "chrome.exe" if KK.current_platform() == "win32" else "chrome"

    def ensure(cache_dir, kv=None, on_progress=None, **kwargs):
        path = KK.kernel_dir(cache_dir, (kv or KK.default_kernel_version()).version) / exe
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        return path

    monkeypatch.setattr(B._kernel, "ensure_kernel", ensure)
    info = L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=5, sync=False)
    monkeypatch.setattr(B, "get_license_token", lambda *a, **k: info)
    monkeypatch.delenv("ANTIBROW_GEO_SERVER", raising=False)
    proxy_targets = []

    def fake_proxy_lookup(spec, target, timeout):
        proxy_targets.append(target.host)
        return None

    monkeypatch.setattr(G, "_lookup_via_http_proxy", fake_proxy_lookup)
    return proxy_targets


def test_launch_geo_lookups_stay_on_the_custom_server(hosts, prep, tmp_path):
    # launch_async runs this same function in a worker thread.
    cache = tmp_path / "cache"
    B.prepare_launch("p-direct", server=SERVER, cache_dir=cache, geoip=True, focus_window=False)
    B.prepare_launch(
        "p-proxy", server=SERVER, cache_dir=cache, geoip=True, focus_window=False,
        proxy="http://user:pw@proxy.example.net:8080",
    )
    assert "api.acme.com" in hosts
    assert "api.acme.com" in prep
    assert [h for h in hosts + prep if h not in ALLOWED and h != "proxy.example.net"] == []
    assert "antibrow.com" not in hosts + prep
