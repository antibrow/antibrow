"""The server side of cloud sync: presigned archive URLs and profile creation.

Driven against a real localhost HTTP server so the request line, the headers and
the percent-encoding of the profile name are all asserted as the server sees
them - a name like ``a@b.com`` reaching the route undecoded is exactly how sync
went silently missing once before.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from antibrow import profile_sync as S


class _Handler(BaseHTTPRequestHandler):
    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "auth": self.headers.get("Authorization"),
                "body": body.decode() if body else "",
            }
        )
        status, payload = self.server.routes.get(
            (self.command, self.path.split("?")[0]), (404, {"error": "not found"})
        )
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = _respond  # noqa: N815 - BaseHTTPRequestHandler API
    do_POST = _respond  # noqa: N815

    def log_message(self, *args):
        pass


@pytest.fixture
def api():
    """A localhost stand-in for the AntiBrow server."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.routes = {}
    httpd.requests = []
    httpd.base = "http://127.0.0.1:{0}".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


# -- presigned archive URLs ----------------------------------------------


def test_archive_urls_come_from_the_get_and_post_pair(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1/archive"): (200, {"downloadUrl": "https://r2/get"}),
        ("POST", "/api/v1/profiles/p1/archive"): (200, {"uploadUrl": "https://r2/put"}),
    }

    urls = S.get_profile_archive_urls("adb_key", api.base, name="p1")

    assert urls.download_url == "https://r2/get"
    assert urls.upload_url == "https://r2/put"
    assert {r["auth"] for r in api.requests} == {"Bearer adb_key"}


def test_archive_urls_carry_the_generation_the_server_reports(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1/archive"): (200, {"downloadUrl": "https://r2/get", "version": "abc123"}),
        ("POST", "/api/v1/profiles/p1/archive"): (200, {"uploadUrl": "https://r2/put"}),
    }

    urls = S.get_profile_archive_urls("adb_key", api.base, name="p1")

    assert urls.version == "abc123"


def test_archive_urls_version_is_none_on_a_server_that_predates_it(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1/archive"): (200, {"downloadUrl": "https://r2/get"}),
        ("POST", "/api/v1/profiles/p1/archive"): (200, {"uploadUrl": "https://r2/put"}),
    }

    urls = S.get_profile_archive_urls("adb_key", api.base, name="p1")

    assert urls.version is None


def test_a_plan_without_sync_gets_no_urls_and_no_exception(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1/archive"): (403, {"error": "Profile sync requires a paid plan."}),
        ("POST", "/api/v1/profiles/p1/archive"): (403, {"error": "Profile sync requires a paid plan."}),
    }

    urls = S.get_profile_archive_urls("adb_key", api.base, name="p1")

    assert urls.download_url is None
    assert urls.upload_url is None
    assert bool(urls) is False


def test_the_profile_name_is_encoded_for_a_path_segment(api):
    # `@` is legal raw in a path segment and stays raw on purpose: escaping it
    # alongside a space produces a segment the server reads as double-encoded
    # and refuses outright. See antibrow.config.encode_path_segment.
    S.get_profile_archive_urls("adb_key", api.base, name="a@b.com")
    assert {r["path"] for r in api.requests} == {"/api/v1/profiles/a@b.com/archive"}

    api.requests.clear()
    S.get_profile_archive_urls("adb_key", api.base, name="work mail@b.com")
    assert {r["path"] for r in api.requests} == {"/api/v1/profiles/work%20mail@b.com/archive"}


# -- making sure the server knows the profile ---------------------------


def test_ensure_creates_the_profile_when_the_server_has_never_seen_it(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1"): (404, {"error": "not found"}),
        ("POST", "/api/v1/profiles"): (200, {"name": "p1"}),
    }

    assert S.ensure_server_profile("adb_key", api.base, name="p1", tags=["agent"]) is True

    created = [r for r in api.requests if r["method"] == "POST"]
    assert json.loads(created[0]["body"]) == {"name": "p1", "tags": ["agent"]}


def test_ensure_does_not_recreate_an_existing_profile(api):
    api.routes = {("GET", "/api/v1/profiles/p1"): (200, {"name": "p1"})}

    assert S.ensure_server_profile("adb_key", api.base, name="p1") is True
    assert [r["method"] for r in api.requests] == ["GET"]


def test_ensure_treats_a_creation_race_as_success(api):
    api.routes = {
        ("GET", "/api/v1/profiles/p1"): (404, {"error": "not found"}),
        ("POST", "/api/v1/profiles"): (409, {"error": "already exists"}),
    }

    assert S.ensure_server_profile("adb_key", api.base, name="p1") is True


def test_ensure_reports_failure_instead_of_raising(api):
    api.routes = {("GET", "/api/v1/profiles/p1"): (500, {"error": "boom"})}

    assert S.ensure_server_profile("adb_key", api.base, name="p1") is False
