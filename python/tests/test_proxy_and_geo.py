"""Proxy parsing plus the offline parts of the geo lookup."""

from __future__ import annotations

import json

import pytest

from antibrow.errors import ProxyError
from antibrow.geoip import dechunk, parse_geo_response, split_http_response
from antibrow.proxy import ProxySpec, parse_proxy, redact

# -- parsing --------------------------------------------------------------


def test_full_url_with_credentials():
    spec = parse_proxy("http://alice:s3cr3t@gate.example.com:8080")
    assert (spec.scheme, spec.host, spec.port) == ("http", "gate.example.com", 8080)
    assert (spec.username, spec.password) == ("alice", "s3cr3t")
    assert spec.has_credentials


def test_percent_encoded_credentials_are_decoded_for_the_kernel():
    # Residential pools hand out passwords with @ and : in them constantly.
    spec = parse_proxy("socks5://us%40er:p%40ss%3Aword@127.0.0.1:1080")
    assert spec.username == "us@er"
    assert spec.password == "p@ss:word"
    # ... and re-encoded when the URL is rebuilt, so the kernel can split it.
    assert spec.to_url() == "socks5://us%40er:p%40ss%3Aword@127.0.0.1:1080"


def test_bare_host_port_defaults_to_http():
    spec = parse_proxy("gate.example.com:3128")
    assert spec.scheme == "http" and spec.port == 3128


def test_playwright_style_mapping_is_accepted():
    spec = parse_proxy({"server": "http://gate.example.com:8080", "username": "u", "password": "p"})
    assert spec.to_url() == "http://u:p@gate.example.com:8080"


def test_mapping_without_a_server_key_is_rejected():
    with pytest.raises(ProxyError, match="server"):
        parse_proxy({"username": "u"})


def test_relay_scheme_survives_and_needs_no_port():
    spec = parse_proxy("relay://key:px_1@proxy.antibrow.com")
    assert spec.is_relay and spec.port is None
    assert spec.to_url() == "relay://key:px_1@proxy.antibrow.com"


@pytest.mark.parametrize("scheme", ["socks5", "socks"])
def test_socks_schemes_are_recognised(scheme):
    assert parse_proxy("{0}://127.0.0.1:1080".format(scheme)).is_socks


@pytest.mark.parametrize("bad", ["", "   ", "ftp://host:21", "http://", "not a url at all"])
def test_bad_proxies_raise_proxy_error(bad):
    with pytest.raises(ProxyError):
        parse_proxy(bad)


def test_none_passes_through():
    assert parse_proxy(None) is None
    assert redact(None) is None


def test_credentials_never_appear_in_logs_or_reprs():
    spec = parse_proxy("http://alice:s3cr3t@gate.example.com:8080")
    assert "s3cr3t" not in str(spec)
    assert redact("http://alice:s3cr3t@gate.example.com:8080") == "http://gate.example.com:8080"


def test_spec_instances_pass_through_unchanged():
    spec = ProxySpec("http", "h", 1)
    assert parse_proxy(spec) is spec


# -- geo response parsing -------------------------------------------------


def test_successful_ip_api_response_is_parsed():
    body = json.dumps(
        {
            "status": "success",
            "country": "United States",
            "countryCode": "US",
            "timezone": "America/Los_Angeles",
            "query": "203.0.113.7",
        }
    )
    geo = parse_geo_response(body)
    assert geo is not None
    assert geo.timezone == "America/Los_Angeles"
    assert geo.ip == "203.0.113.7"
    assert geo.country_code == "US"


@pytest.mark.parametrize(
    "body",
    ['{"status":"fail","message":"private range"}', "not json", "[]", "", "null"],
)
def test_unusable_geo_responses_return_none(body):
    assert parse_geo_response(body) is None


def test_http_response_is_split_into_headers_and_body():
    raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"success\"}"
    head, body = split_http_response(raw)
    assert "200 OK" in head
    assert body == '{"status":"success"}'


def test_chunked_bodies_are_decoded():
    raw = (
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"14\r\n{\"status\":\"success\"}\r\n0\r\n\r\n"
    )
    _, body = split_http_response(raw)
    assert parse_geo_response(body) is not None


def test_dechunk_leaves_a_non_chunked_body_alone():
    assert dechunk('{"a":1}') == '{"a":1}'
