"""License resolution.

The one rule this file exists to protect: **this package never signs a token.**
It resolves an API key, asks the server, and caches the answer.
"""

from __future__ import annotations

import base64
import http.server
import json
import socketserver
import threading
import time

import pytest

from antibrow import config as C
from antibrow import license as L
from antibrow.errors import LicenseError


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for var in (C.ENV_API_KEY, C.ENV_API_KEY_LEGACY, C.ENV_LICENSE_TOKEN, C.ENV_SERVER):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(L, "_cache_file", lambda key, server: tmp_path / "cache.json")
    return home


def make_token(exp=None, mi=5, sig=b"\x01" * 64):
    payload = json.dumps(
        {"v": 1, "iat": int(time.time()), "exp": int(exp or time.time() + 86400), "mi": mi},
        separators=(",", ":"),
    ).encode("utf-8")
    return "{0}.{1}".format(
        base64.b64encode(payload).decode(), base64.b64encode(sig).decode()
    )


# -- no signing key anywhere ---------------------------------------------


def test_the_package_ships_no_private_key():
    """A distributable that can mint its own tokens is a license bypass.

    Guards against the mistake the Node SDK started with: an embedded Ed25519
    seed that anyone could unpack out of the released artifact.
    """
    import inspect
    import re

    from antibrow import browser, cli, kernel, launcher, persona, proxy

    signing_markers = (
        "private_key",
        "privkey",
        "signingkey",
        "begin private key",
        "ed25519privatekey",
        "nacl.signing",
        "cryptography.hazmat",
    )
    embedded_seed = re.compile(r"[\"'][0-9a-f]{64}[\"']")  # a hex Ed25519 seed

    for module in (L, browser, kernel, launcher, persona, proxy, cli):
        source = inspect.getsource(module)
        lowered = source.lower()
        for marker in signing_markers:
            assert marker not in lowered, "{0} mentions {1}".format(module.__name__, marker)
        assert not embedded_seed.search(source), "{0} embeds a key-sized hex literal".format(
            module.__name__
        )


# -- token payload --------------------------------------------------------


def test_token_payload_is_readable_without_verifying_the_signature():
    token = make_token(exp=1893456000, mi=20)
    payload = L.parse_token_payload(token)
    assert payload["exp"] == 1893456000
    assert payload["mi"] == 20


def test_malformed_tokens_parse_to_an_empty_payload():
    for bad in ("", "no-dot", "!!!.!!!", "e30", "...."):
        assert L.parse_token_payload(bad) == {}


# -- key resolution -------------------------------------------------------


def test_key_resolution_order_argument_env_file(monkeypatch):
    assert L.resolve_api_key() is None

    L.write_key_file("from-file")
    assert L.resolve_api_key() == "from-file"
    assert L.api_key_source() == str(L.key_file_path())

    monkeypatch.setenv(C.ENV_API_KEY_LEGACY, "from-legacy-env")
    assert L.resolve_api_key() == "from-legacy-env"

    monkeypatch.setenv(C.ENV_API_KEY, "from-env")
    assert L.resolve_api_key() == "from-env"
    assert L.api_key_source() == "env:ANTIBROW_API_KEY"

    assert L.resolve_api_key("explicit") == "explicit"
    assert L.api_key_source("explicit") == "argument"


def test_key_file_ignores_comments_and_blank_lines():
    path = L.key_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# my key\n\n  ab_live_123  \n", encoding="utf-8")
    assert L.read_key_file() == "ab_live_123"


def test_missing_key_raises_an_actionable_error():
    with pytest.raises(LicenseError) as excinfo:
        L.get_license_token()
    message = str(excinfo.value)
    assert "antibrow login" in message
    assert C.ENV_API_KEY in message
    assert "https://antibrow.com" in message


# -- explicit token / custom provider ------------------------------------


def test_pre_minted_token_short_circuits_the_server():
    token = make_token(mi=3)
    info = L.get_license_token(license_token=token)
    assert info.token == token and info.mi == 3


def test_environment_token_is_honoured(monkeypatch):
    token = make_token(mi=7)
    monkeypatch.setenv(C.ENV_LICENSE_TOKEN, token)
    assert L.get_license_token().mi == 7


def test_custom_provider_can_return_a_string_or_a_license_info():
    token = make_token()
    assert L.get_license_token(license_provider=lambda: token).token == token

    info = L.LicenseInfo(token="t", exp=int(time.time()) + 60, mi=99, sync=True)
    assert L.get_license_token(license_provider=lambda: info) is info


# -- caching --------------------------------------------------------------


def test_fresh_cache_is_reused_and_stale_cache_is_ignored(monkeypatch, tmp_path):
    calls = []

    def fake_fetch(key, server):
        calls.append((key, server))
        return L.LicenseInfo(token=make_token(), exp=int(time.time()) + 86400, mi=5)

    monkeypatch.setattr(L, "fetch_license_token", fake_fetch)
    monkeypatch.setenv(C.ENV_API_KEY, "k")

    first = L.get_license_token()
    second = L.get_license_token()
    assert len(calls) == 1 and first.token == second.token

    # A token inside the safety margin must be refetched, not handed out.
    L._write_cache(
        tmp_path / "cache.json",
        L.LicenseInfo(token="old", exp=int(time.time()) + L.EXPIRY_SAFETY_MARGIN - 10, mi=1),
    )
    L.get_license_token()
    assert len(calls) == 2


def test_cache_file_shape_matches_the_node_sdk(tmp_path):
    info = L.LicenseInfo(token="t", exp=123, mi=5, sync=True)
    L._write_cache(tmp_path / "cache.json", info)
    on_disk = json.loads((tmp_path / "cache.json").read_text(encoding="utf-8"))
    assert on_disk == {"token": "t", "exp": 123, "mi": 5, "sync": True}
    assert L._read_cache(tmp_path / "cache.json") == info


def test_unreadable_or_incomplete_cache_is_treated_as_missing(tmp_path):
    path = tmp_path / "cache.json"
    assert L._read_cache(path) is None
    path.write_text("{}", encoding="utf-8")
    assert L._read_cache(path) is None
    path.write_text('{"token": "t"}', encoding="utf-8")
    assert L._read_cache(path) is None


def test_freshness_uses_the_safety_margin():
    assert L.LicenseInfo("t", int(time.time()) + 86400).is_fresh()
    assert not L.LicenseInfo("t", int(time.time()) + 60).is_fresh()
    assert not L.LicenseInfo("t", int(time.time()) - 1).is_fresh()


# -- server round trip (localhost, offline) -------------------------------


class _TokenHandler(http.server.BaseHTTPRequestHandler):
    token_response = None
    status = 200
    seen = []

    def do_POST(self):
        _TokenHandler.seen.append((self.path, self.headers.get("Authorization")))
        body = json.dumps(_TokenHandler.token_response or {}).encode()
        self.send_response(_TokenHandler.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def token_server():
    _TokenHandler.seen = []

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    server = Server(("127.0.0.1", 0), _TokenHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield "http://127.0.0.1:{0}".format(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()


def test_fetch_hits_the_documented_endpoint_with_a_bearer_key(token_server):
    token = make_token(mi=20)
    _TokenHandler.status = 200
    _TokenHandler.token_response = {"token": token, "exp": 1893456000, "mi": 20, "sync": True}

    info = L.fetch_license_token("ab_live_key", token_server)
    assert info.token == token and info.mi == 20 and info.sync is True and info.exp == 1893456000
    assert _TokenHandler.seen == [("/api/v1/engine/token", "Bearer ab_live_key")]


def test_missing_exp_and_mi_fall_back_to_the_token_payload(token_server):
    token = make_token(exp=1893456000, mi=9)
    _TokenHandler.status = 200
    _TokenHandler.token_response = {"token": token}

    info = L.fetch_license_token("k", token_server)
    assert info.exp == 1893456000 and info.mi == 9


def test_a_rejected_key_says_so_plainly(token_server):
    _TokenHandler.status = 401
    _TokenHandler.token_response = {"error": {"message": "invalid key"}}
    with pytest.raises(LicenseError, match="Authentication failed"):
        L.fetch_license_token("bad", token_server)


def test_server_errors_are_wrapped(token_server):
    _TokenHandler.status = 500
    _TokenHandler.token_response = {"error": {"message": "boom"}}
    with pytest.raises(LicenseError, match="HTTP 500"):
        L.fetch_license_token("k", token_server)


def test_a_response_without_a_token_is_an_error(token_server):
    _TokenHandler.status = 200
    _TokenHandler.token_response = {"exp": 1}
    with pytest.raises(LicenseError, match="no token"):
        L.fetch_license_token("k", token_server)


def test_an_unreachable_server_names_the_url():
    with pytest.raises(LicenseError, match="Could not reach"):
        # Port 9 (discard) refuses connections quickly on every platform.
        L.fetch_license_token("k", "http://127.0.0.1:9")
