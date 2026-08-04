"""Every outbound request must name itself.

urllib's default ``Python-urllib/3.x`` is refused outright by the CDN in front of
the kernel downloads (Cloudflare error 1010, "banned browser signature"), which
made a first-time kernel install fail with a bare HTTP 403 and made the manifest
refresh fail silently. So the User-Agent is part of the contract, not cosmetics.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from antibrow import config as C
from antibrow import kernel as K
from antibrow import license as L
from antibrow import profile_cache as P
from antibrow import profile_sync as S


class _Handler(BaseHTTPRequestHandler):
    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.server.agents.append(self.headers.get("User-Agent"))
        body = self.server.body
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _respond  # noqa: N815 - BaseHTTPRequestHandler API
    do_POST = _respond  # noqa: N815
    do_PUT = _respond  # noqa: N815

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.agents = []
    httpd.body = b"{}"
    httpd.base = "http://127.0.0.1:{0}".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def test_the_user_agent_names_the_sdk():
    assert C.USER_AGENT.startswith("antibrow-python")
    assert "urllib" not in C.USER_AGENT


def test_the_kernel_manifest_request_names_the_sdk(server):
    server.body = json.dumps({"versions": []}).encode()

    K.fetch_remote_kernel_versions("{0}/versions.json".format(server.base))

    assert server.agents == [C.USER_AGENT]


def test_the_kernel_download_names_the_sdk(server, tmp_path):
    server.body = b"zip-bytes"

    K._download("{0}/kernel.zip".format(server.base), tmp_path / "k.zip")

    assert server.agents == [C.USER_AGENT]


def test_the_license_request_names_the_sdk(server):
    server.body = json.dumps({"token": "a.b", "exp": 2**31}).encode()

    L.fetch_license_token("adb_key", server.base)

    assert server.agents == [C.USER_AGENT]


def test_the_archive_transfers_name_the_sdk(server, tmp_path):
    server.body = P.pack_profile_cache(tmp_path)

    P.download_profile_cache("{0}/archive.zip".format(server.base), tmp_path / "dest")
    P.upload_profile_cache(tmp_path, "{0}/archive.zip".format(server.base))

    assert server.agents == [C.USER_AGENT, C.USER_AGENT]


def test_the_sync_api_requests_name_the_sdk(server):
    S.get_profile_archive_urls("adb_key", server.base, name="p1")

    assert server.agents == [C.USER_AGENT, C.USER_AGENT]
