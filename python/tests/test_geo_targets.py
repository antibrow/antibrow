"""Our own geo endpoint first, ip-api behind it. Mirrors oss/js engine-geo-targets."""

import json

import pytest

from antibrow import geoip

SERVER_BODY = json.dumps({
    "ip": "203.0.113.7", "country": "JP", "countryCode": "JP",
    "countryName": "Japan", "city": "Osaka", "timezone": "Asia/Tokyo",
})
IPAPI_BODY = json.dumps({
    "status": "success", "query": "203.0.113.7", "country": "Japan",
    "countryCode": "JP", "city": "Osaka", "timezone": "Asia/Tokyo",
})


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("ANTIBROW_GEO_SERVER", raising=False)
    monkeypatch.delenv("ANTIBROW_SERVER", raising=False)


def test_own_endpoint_comes_first():
    own, fallback = geoip.geo_targets()
    assert (own.host, own.port, own.tls, own.path) == ("antibrow.com", 443, True, "/api/v1/geo")
    assert (fallback.host, fallback.port, fallback.tls) == ("ip-api.com", 80, False)


def test_self_hosted_server_url():
    own = geoip.geo_targets("https://geo.example.com:8443/base/")[0]
    assert own.host == "geo.example.com"
    assert own.port == 8443
    assert own.path == "/base/api/v1/geo"
    assert own.url == "https://geo.example.com:8443/base/api/v1/geo"


def test_env_override(monkeypatch):
    monkeypatch.setenv("ANTIBROW_GEO_SERVER", "https://staging.example.com")
    assert geoip.geo_targets()[0].host == "staging.example.com"


def test_unparseable_server_url_leaves_only_ip_api():
    targets = geoip.geo_targets("not a url")
    assert [t.host for t in targets] == ["ip-api.com"]


def test_both_endpoints_parse_to_the_same_shape():
    own, ipapi = geoip.geo_targets()
    assert geoip.parse_geo_body(own, SERVER_BODY) == geoip.parse_geo_body(ipapi, IPAPI_BODY)


def test_own_body_without_a_timezone_is_rejected():
    own = geoip.geo_targets()[0]
    body = json.dumps({"ip": "203.0.113.7", "country": None, "timezone": None})
    assert geoip.parse_geo_body(own, body) is None


def test_own_body_without_an_exit_ip_is_rejected():
    # An older deployment answers without one, and no ip switches WebRTC off.
    own = geoip.geo_targets()[0]
    body = json.dumps({"country": "JP", "countryCode": "JP", "timezone": "Asia/Tokyo"})
    assert geoip.parse_geo_body(own, body) is None


def test_ip_api_failure_body_is_still_rejected():
    ipapi = geoip.geo_targets()[1]
    assert geoip.parse_geo_body(ipapi, '{"status":"fail","message":"quota"}') is None


def _stub(monkeypatch, seen, outcome):
    def lookup(spec, target, timeout):
        seen.append(target.host)
        body = outcome.get(target.host)
        if body is None:
            raise RuntimeError("no stub for {0}".format(target.host))
        return geoip.parse_geo_body(target, body)

    monkeypatch.setattr(geoip, "_lookup_via_http_proxy", lookup)


def test_stops_at_our_own_endpoint_when_it_answers(monkeypatch):
    seen = []
    _stub(monkeypatch, seen, {"antibrow.com": SERVER_BODY})
    geo = geoip.lookup_proxy_geo("http://p.example.com:8080", timeout=2.0)
    assert geo is not None and geo.timezone == "Asia/Tokyo"
    assert seen == ["antibrow.com"]


def test_falls_through_to_ip_api(monkeypatch):
    seen = []
    _stub(monkeypatch, seen, {"ip-api.com": IPAPI_BODY})
    geo = geoip.lookup_proxy_geo("http://p.example.com:8080", timeout=2.0)
    assert geo is not None and geo.country_code == "JP"
    assert seen == ["antibrow.com", "ip-api.com"]


def test_returns_none_when_every_target_fails(monkeypatch):
    seen = []
    _stub(monkeypatch, seen, {})
    assert geoip.lookup_proxy_geo("http://p.example.com:8080", timeout=2.0) is None
    assert seen == ["antibrow.com", "ip-api.com"]


def test_relay_tunnel_skips_the_tls_target(monkeypatch):
    # The tunnel writes the HTTP request itself, so an HTTPS target would go out
    # in clear text; it must be skipped, not downgraded.
    seen = []

    def fake_fetch(url, *, host, port, path, timeout, insecure=False):
        seen.append((host, port))
        return IPAPI_BODY

    monkeypatch.setattr("antibrow.relay_tunnel.relay_fetch", fake_fetch)
    key = "a" * 43
    geo = geoip.lookup_proxy_geo(
        "relay://u:p@r.example.com?key={0}".format(key), timeout=2.0
    )
    assert geo is not None and geo.timezone == "Asia/Tokyo"
    assert seen == [("ip-api.com", 80)]
