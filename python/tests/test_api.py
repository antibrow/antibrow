"""The account's cloud resources.

Every call runs against a real localhost HTTP server rather than a patched
``urlopen``: the interesting failures here are the ones that only exist at the
socket level - which method was used, what the body actually was, and which
status came back.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from antibrow import api
from antibrow.errors import ApiError


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # keep the test output clean
        pass

    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        route = self.server.routes.get((self.command, self.path.split("?")[0]))
        self.server.calls.append(
            {
                "method": self.command,
                "path": self.path,
                "body": json.loads(body) if body else None,
                "auth": self.headers.get("Authorization"),
                "agent": self.headers.get("User-Agent"),
            }
        )
        status, payload = route if route else (404, {"error": "no_route"})
        encoded = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = do_POST = do_PUT = do_DELETE = _respond


@pytest.fixture
def server():
    """A stub server. Register routes as ``(METHOD, path) -> (status, body)``."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.routes = {}
    httpd.calls = []
    httpd.url = "http://127.0.0.1:{0}".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


PROFILE_BODY = {
    "id": "p-1",
    "name": "shopper",
    "config": {"group": "ads", "canvasNoise": False, "proxy": {"kind": "managed", "managedProxyId": "mp-9"}},
    "createdAt": "2026-08-01T00:00:00Z",
    "updatedAt": "2026-08-02T00:00:00Z",
    "deletedAt": None,
}


class TestProfiles:
    def test_create_sends_the_config_the_server_expects(self, server):
        server.routes[("POST", "/api/v1/profiles")] = (201, PROFILE_BODY)

        profile = api.create_profile(
            "adb_k",
            server.url,
            name="shopper",
            tags=["ads"],
            config=api.ProfileConfig(group="ads", canvas_noise=False),
        )

        assert profile.id == "p-1"
        assert profile.config.canvas_noise is False
        call = server.calls[0]
        assert call["auth"] == "Bearer adb_k"
        assert call["body"] == {"name": "shopper", "tags": ["ads"], "config": {"group": "ads", "canvasNoise": False}}

    def test_an_unset_config_field_is_omitted_rather_than_sent_as_null(self, server):
        server.routes[("PUT", "/api/v1/profiles/p-1")] = (200, PROFILE_BODY)

        api.update_profile("adb_k", server.url, id="p-1", config=api.ProfileConfig(label="Main"))

        # A null would clear the server's value; an absent key leaves it alone.
        assert server.calls[0]["body"] == {"config": {"label": "Main"}}

    def test_a_name_needing_encoding_reaches_the_right_route(self, server):
        # The space is escaped, the @ is not: the server's double-encoding guard
        # refuses a segment that partially decodes and still holds a %xx, and its
        # decodeURI turns %20 back into a space while leaving %40 alone.
        server.routes[("GET", "/api/v1/profiles/work%20mail@example.com")] = (200, PROFILE_BODY)

        assert api.get_profile("adb_k", server.url, name="work mail@example.com").name == "shopper"

    def test_failure_carries_the_status_and_the_server_reason(self, server):
        server.routes[("GET", "/api/v1/profiles/gone")] = (404, {"error": "not_found"})

        with pytest.raises(ApiError) as caught:
            api.get_profile("adb_k", server.url, name="gone")

        assert caught.value.status == 404
        assert "not_found" in str(caught.value)

    def test_get_or_create_creates_only_after_a_404(self, server):
        server.routes[("GET", "/api/v1/profiles/fresh")] = (404, {"error": "not_found"})
        server.routes[("POST", "/api/v1/profiles")] = (201, PROFILE_BODY)

        assert api.get_or_create_profile("adb_k", server.url, name="fresh").id == "p-1"
        assert [c["method"] for c in server.calls] == ["GET", "POST"]

    def test_get_or_create_reads_again_when_another_process_won_the_race(self, server):
        server.routes[("GET", "/api/v1/profiles/fresh")] = (404, {"error": "not_found"})
        server.routes[("POST", "/api/v1/profiles")] = (409, {"error": "exists"})

        with pytest.raises(ApiError):
            api.get_or_create_profile("adb_k", server.url, name="fresh")
        # GET, POST, then the second GET - which 404s again here, but it was made.
        assert [c["method"] for c in server.calls] == ["GET", "POST", "GET"]

    def test_get_or_create_does_not_create_over_an_unrelated_failure(self, server):
        server.routes[("GET", "/api/v1/profiles/fresh")] = (500, {"error": "boom"})

        with pytest.raises(ApiError) as caught:
            api.get_or_create_profile("adb_k", server.url, name="fresh")

        assert caught.value.status == 500
        assert [c["method"] for c in server.calls] == ["GET"]

    def test_delta_pull_passes_since_and_reports_the_server_clock(self, server):
        server.routes[("GET", "/api/v1/profiles")] = (
            200,
            {"profiles": [PROFILE_BODY], "serverTime": "2026-08-14T10:00:00Z"},
        )

        page = api.sync_pull_profiles("adb_k", server.url, since="2026-08-01T00:00:00Z")

        assert page.server_time == "2026-08-14T10:00:00Z"
        assert page.profiles[0].name == "shopper"
        assert "since=2026-08-01" in server.calls[0]["path"]

    def test_delete_needs_something_to_address(self):
        with pytest.raises(ValueError):
            api.delete_profile("adb_k", "http://unused")

    def test_launch_details_follow_a_managed_proxy_reference(self, server):
        server.routes[("GET", "/api/v1/profiles/shopper")] = (200, PROFILE_BODY)

        launch = api.get_profile_for_launch("adb_k", server.url, name="shopper")

        assert launch.profile == "shopper"
        assert launch.proxy_id == "mp-9"
        assert launch.proxy is None

    def test_launch_details_resolve_a_local_proxy_into_a_url(self, server):
        body = dict(PROFILE_BODY, config={"proxy": {"kind": "local", "localProxyId": "lp-3"}})
        server.routes[("GET", "/api/v1/profiles/shopper")] = (200, body)
        server.routes[("GET", "/api/v1/proxy-library")] = (
            200,
            {
                "proxies": [
                    {"id": "lp-3", "config": {"type": "SOCKS5", "host": "h", "port": 1080, "username": "u", "password": "p"}}
                ],
                "serverTime": "",
            },
        )

        launch = api.get_profile_for_launch("adb_k", server.url, name="shopper")

        assert launch.proxy == "socks5://u:p@h:1080"
        assert launch.proxy_id is None


class TestProfileState:
    def test_upload_signs_then_puts_without_leaking_the_key_to_storage(self, server):
        server.routes[("POST", "/api/v1/profiles/shopper/state")] = (
            200,
            {"uploadUrl": "{0}/r2-put".format(server.url)},
        )
        server.routes[("PUT", "/r2-put")] = (200, {})

        api.upload_profile_state(
            "adb_k",
            server.url,
            name="shopper",
            cookies=[api.ProfileStateCookie(name="sid", value="abc", domain=".example.com")],
            tabs=["https://example.com"],
        )

        sign, put = server.calls
        assert sign["auth"] == "Bearer adb_k"
        # A presigned URL authenticates itself; the key has no business there.
        assert put["auth"] is None
        assert put["body"]["cookies"] == [{"name": "sid", "value": "abc", "domain": ".example.com"}]
        assert put["body"]["tabs"] == ["https://example.com"]

    def test_download_returns_none_for_a_profile_that_never_uploaded(self, server):
        server.routes[("GET", "/api/v1/profiles/shopper/state")] = (404, {"error": "no_state"})

        assert api.download_profile_state("adb_k", server.url, name="shopper") is None

    def test_download_reads_the_stored_state(self, server):
        server.routes[("GET", "/api/v1/profiles/shopper/state")] = (
            200,
            {"downloadUrl": "{0}/r2-get".format(server.url)},
        )
        server.routes[("GET", "/r2-get")] = (
            200,
            {
                "cookies": [{"name": "sid", "value": "abc"}],
                "origins": [{"origin": "https://example.com", "localStorage": [{"name": "k", "value": "v"}]}],
                "tabs": ["https://example.com"],
                "permissions": None,
                "serviceWorkers": None,
            },
        )

        state = api.download_profile_state("adb_k", server.url, name="shopper")

        assert state.cookies[0].name == "sid"
        assert state.origins[0].local_storage == [{"name": "k", "value": "v"}]

    def test_a_missing_storage_object_is_absent_state_not_an_error(self, server):
        server.routes[("GET", "/api/v1/profiles/shopper/state")] = (
            200,
            {"downloadUrl": "{0}/r2-get".format(server.url)},
        )
        server.routes[("GET", "/r2-get")] = (403, None)

        assert api.download_profile_state("adb_k", server.url, name="shopper") is None


class TestProxies:
    def test_listing_reports_the_quota_beside_the_proxies(self, server):
        server.routes[("GET", "/api/v1/proxies")] = (
            200,
            {
                "proxies": [{"id": "mp-1", "protocol": "http", "displayName": "managed 1"}],
                "quota": {"limit": 5, "usedThisMonth": 2, "remaining": 3, "holdCount": 1, "holdCap": 2},
            },
        )

        listing = api.list_proxies("adb_k", server.url)

        assert listing.proxies[0].display_name == "managed 1"
        assert listing.quota.remaining == 3

    def test_claim_and_swap_post_their_action(self, server):
        server.routes[("POST", "/api/v1/proxies")] = (200, {"proxy": {"id": "mp-2", "protocol": "http"}})

        assert api.claim_managed_proxy("adb_k", server.url).id == "mp-2"
        assert api.swap_managed_proxy("adb_k", server.url, proxy_id="mp-1").id == "mp-2"

        assert [c["body"]["action"] for c in server.calls] == ["claim", "swap"]

    def test_quota_exhaustion_says_so_rather_than_reporting_a_bare_403(self, server):
        server.routes[("POST", "/api/v1/proxies/mp-1/activate")] = (403, {"error": "quota"})

        with pytest.raises(ApiError, match="quota"):
            api.activate_proxy("adb_k", server.url, proxy_id="mp-1")

    def test_a_ticket_route_that_is_not_deployed_is_not_a_missing_proxy(self, server):
        # A live route answers 404 only with not_your_proxy. A bare 404 means the
        # endpoint is not there, and calling that "proxy not found" sends whoever
        # debugs it down the wrong path.
        server.routes[("POST", "/api/v1/proxies/mp-1/ticket")] = (404, {"error": "no_route"})

        with pytest.raises(ApiError, match="does not support managed proxy tickets"):
            api.issue_proxy_ticket("adb_k", server.url, proxy_id="mp-1")

    def test_a_ticket_for_someone_elses_proxy_says_that_instead(self, server):
        server.routes[("POST", "/api/v1/proxies/mp-1/ticket")] = (404, {"error": "not_your_proxy"})

        with pytest.raises(ApiError, match="does not belong to you"):
            api.issue_proxy_ticket("adb_k", server.url, proxy_id="mp-1")

    def test_issuing_a_ticket_returns_the_short_lived_credentials(self, server):
        server.routes[("POST", "/api/v1/proxies/mp-1/ticket")] = (
            200,
            {
                "ticketId": "t-1",
                "username": "mp-1",
                "password": "secret",
                "host": "proxy.antibrow.com",
                "expiresAt": "2026-08-14T11:00:00Z",
            },
        )

        ticket = api.issue_proxy_ticket("adb_k", server.url, proxy_id="mp-1", label="shopper", ttl_minutes=30)

        assert ticket.ticket_id == "t-1"
        assert server.calls[0]["body"] == {"label": "shopper", "ttlMinutes": 30}

    def test_revoking_never_raises(self, server):
        server.routes[("DELETE", "/api/v1/proxies/mp-1/ticket")] = (500, {"error": "boom"})

        api.revoke_proxy_ticket("adb_k", server.url, proxy_id="mp-1", ticket_id="t-1")

        assert "ticketId=t-1" in server.calls[0]["path"]

    def test_relay_url_escapes_credentials(self):
        url = api.managed_proxy_to_relay_url("user name", "p@ss/word")

        assert url == "relay://user%20name:p%40ss%2Fword@proxy.antibrow.com"

    def test_proxy_config_urls_map_each_type_to_its_scheme(self):
        def url(kind):
            return api.proxy_config_to_url(api.ProxyConfig(type=kind, host="h", port=1))

        assert url("SOCKS5").startswith("socks5://")
        assert url("SSH").startswith("ssh://")
        assert url("HTTP").startswith("http://")


class TestAccount:
    def test_reports_the_plan_and_what_is_left_of_it(self, server):
        server.routes[("GET", "/api/v1/account")] = (
            200,
            {
                "email": "a@b.com",
                "plan": "BASIC",
                "expiresAt": None,
                "concurrency": 5,
                "syncEnabled": True,
                "profileLimit": 20,
                "profileCount": 11,
                "profileRemaining": 9,
            },
        )

        account = api.get_account("adb_k", server.url)

        assert (account.plan, account.concurrency, account.sync_enabled) == ("BASIC", 5, True)
        assert account.profile_remaining == 9


def test_every_request_carries_an_explicit_user_agent(server):
    # Cloudflare rejects the stdlib default outright (error 1010), which turned
    # every call to our own domains into a bare 403.
    server.routes[("GET", "/api/v1/account")] = (200, {})

    api.get_account("adb_k", server.url)

    agent = server.calls[0]["agent"]
    assert agent and "python-urllib" not in agent.lower()


def test_an_unreachable_server_is_reported_as_such(monkeypatch):
    with pytest.raises(ApiError) as caught:
        # Port 1 on localhost refuses immediately.
        api.get_account("adb_k", "http://127.0.0.1:1")

    assert caught.value.status == 0
    assert "could not be reached" in str(caught.value)
