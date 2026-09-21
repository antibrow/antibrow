"""Which probe path a relay proxy takes, by whether it carries a key."""

import base64
import os

from antibrow import geoip

KEY = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
GEO = (
    '{"status":"success","country":"United States","countryCode":"US",'
    '"timezone":"America/Los_Angeles","query":"203.0.113.7"}'
)


def test_keyed_relay_probes_through_the_encrypted_tunnel(monkeypatch):
    seen = {}

    def fake_fetch(url, *, host, port, path, timeout, insecure=False):
        seen.update(url=url, host=host, port=port)
        return GEO

    monkeypatch.setattr("antibrow.relay_tunnel.relay_fetch", fake_fetch)
    monkeypatch.setattr(
        geoip, "_lookup_via_relay", lambda *a, **k: _fail("header path must not run")
    )

    geo = geoip.lookup_proxy_geo(
        "relay://alice:s3cret@r.example.com?key={0}".format(KEY), timeout=2.0
    )

    assert geo is not None
    assert geo.timezone == "America/Los_Angeles"
    assert seen["host"] == "ip-api.com" and seen["port"] == 80
    assert "key={0}".format(KEY) in seen["url"]


def test_keyless_relay_stays_on_the_header_path(monkeypatch):
    # The managed relay has no key and speaks the legacy protocol; a tunnel
    # attempt there would break every managed-proxy launch.
    called = {"header": False}

    def header(spec, target, timeout):
        called["header"] = True
        return None

    monkeypatch.setattr(geoip, "_lookup_via_relay", header)
    monkeypatch.setattr(
        "antibrow.relay_tunnel.relay_fetch",
        lambda *a, **k: _fail("tunnel path must not run"),
    )

    geoip.lookup_proxy_geo("relay://id:ticket@proxy.example.com", timeout=2.0)

    assert called["header"] is True


def _fail(message):
    raise AssertionError(message)
