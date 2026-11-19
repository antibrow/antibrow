from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from antibrow import server_config as SC
from antibrow.config import USER_AGENT

FIXTURE = Path(__file__).parent / "fixtures" / "server-config-cache.json"
OEM = json.loads(FIXTURE.read_text(encoding="utf-8"))


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        srv = self.server
        srv.requests.append((self.path, self.headers.get("User-Agent")))
        body = json.dumps(srv.body).encode("utf-8")
        self.send_response(srv.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def oem_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.requests = []
    httpd.body = OEM
    httpd.status = 200
    httpd.base = "http://127.0.0.1:{0}".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("ANTIBROW_SERVER", "ANTI_DETECT_BROWSER_SERVER"):
        monkeypatch.delenv(var, raising=False)


def test_resolve_server_precedence_and_slashes(monkeypatch):
    monkeypatch.setenv("ANTIBROW_SERVER", "https://env.example.com/")
    assert SC.resolve_server("https://api.acme.com///") == "https://api.acme.com"
    assert SC.resolve_server() == "https://env.example.com"
    monkeypatch.delenv("ANTIBROW_SERVER")
    monkeypatch.setenv("ANTI_DETECT_BROWSER_SERVER", "https://legacy.example.com")
    assert SC.resolve_server() == "https://legacy.example.com"
    monkeypatch.delenv("ANTI_DETECT_BROWSER_SERVER")
    assert SC.resolve_server() == SC.DEFAULT_SERVER


def test_fetch_caches_and_names_itself(oem_server, tmp_path):
    config = SC.get_server_config(oem_server.base + "/", str(tmp_path))
    assert config["brand"]["name"] == "Acme Browser"
    assert oem_server.requests[0] == ("/api/v1/config", USER_AGENT)
    file = SC.server_config_cache_path(oem_server.base, str(tmp_path))
    assert file.name.startswith("server-config-") and len(file.stem) == len("server-config-") + 12
    assert file.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_fresh_cache_skips_request_and_force_asks_again(oem_server, tmp_path):
    SC.get_server_config(oem_server.base, str(tmp_path))
    oem_server.body = {**OEM, "brand": {**OEM["brand"], "name": "Changed"}}
    assert SC.get_server_config(oem_server.base, str(tmp_path))["brand"]["name"] == "Acme Browser"
    assert len(oem_server.requests) == 1
    assert SC.get_server_config(oem_server.base, str(tmp_path), force=True)["brand"]["name"] == "Changed"
    assert len(oem_server.requests) == 2


def test_expired_cache_is_refetched(oem_server, tmp_path):
    SC.get_server_config(oem_server.base, str(tmp_path))
    file = SC.server_config_cache_path(oem_server.base, str(tmp_path))
    old = time.time() - 2 * 3600
    os.utime(file, (old, old))
    SC.get_server_config(oem_server.base, str(tmp_path))
    assert len(oem_server.requests) == 2


def test_stale_cache_is_used_when_request_fails(oem_server, tmp_path):
    SC.get_server_config(oem_server.base, str(tmp_path))
    file = SC.server_config_cache_path(oem_server.base, str(tmp_path))
    old = time.time() - 5 * 3600
    os.utime(file, (old, old))
    oem_server.status = 500
    config = SC.get_server_config(oem_server.base, str(tmp_path), force=True)
    assert config["brand"]["name"] == "Acme Browser"


def test_failure_without_cache_turns_business_features_off(oem_server, tmp_path):
    oem_server.status = 404
    config = SC.get_server_config(oem_server.base, str(tmp_path))
    assert config["features"]["cloudSync"] is True
    for name in ("team", "share", "managedProxy", "liveView", "realDevices", "emailLogin"):
        assert config["features"][name] is False
    assert config["recipeRegistryUrl"] == ""
    assert config["kernelManifestUrl"] == SC.DEFAULT_KERNEL_MANIFEST_URL


def test_malformed_body_is_a_failure_and_not_cached(oem_server, tmp_path):
    oem_server.body = {"brand": "nope"}
    config = SC.get_server_config(oem_server.base, str(tmp_path))
    assert config["features"]["managedProxy"] is False
    assert not SC.server_config_cache_path(oem_server.base, str(tmp_path)).exists()


def test_default_server_never_asks(oem_server, tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("no request expected")

    monkeypatch.setattr(SC.urllib.request, "urlopen", boom)
    config = SC.effective_server_config(None, str(tmp_path))
    assert config["features"]["managedProxy"] is True
    assert config["recipeRegistryUrl"] == SC.DEFAULT_RECIPE_REGISTRY_URL
    SC.assert_server_feature(SC.DEFAULT_SERVER, "liveView", str(tmp_path))


def test_assert_feature_raises_with_feature_name(oem_server, tmp_path):
    for feature in ("managedProxy", "liveView", "realDevices", "recipes"):
        with pytest.raises(SC.FeatureUnavailableError) as info:
            SC.assert_server_feature(oem_server.base, feature, str(tmp_path))
        assert info.value.feature == feature
        assert oem_server.base in str(info.value)


def test_assert_feature_passes_when_on(oem_server, tmp_path):
    oem_server.body = {**OEM, "recipeRegistryUrl": "https://r.example.com/registry.json",
                       "features": {**OEM["features"], "managedProxy": True}}
    SC.assert_server_feature(oem_server.base, "managedProxy", str(tmp_path))
    config = SC.assert_server_feature(oem_server.base, "recipes", str(tmp_path))
    assert config["recipeRegistryUrl"] == "https://r.example.com/registry.json"


def test_cache_file_interop(tmp_path):
    server = "https://api.acme.com"
    digest = hashlib.sha256(server.encode("utf-8")).hexdigest()[:12]
    file = SC.server_config_cache_path(server, str(tmp_path))
    assert file.name == "server-config-{0}.json".format(digest)
    shutil.copyfile(FIXTURE, file)

    def boom(*args, **kwargs):
        raise AssertionError("fresh cache must answer")

    from unittest import mock

    with mock.patch.object(SC.urllib.request, "urlopen", boom):
        config = SC.get_server_config(server, str(tmp_path))
    assert config == OEM
    # What Python writes is what the Node SDK parses: same keys, compact JSON.
    SC._write_cache(file, config)
    assert json.loads(file.read_text(encoding="utf-8")) == OEM
