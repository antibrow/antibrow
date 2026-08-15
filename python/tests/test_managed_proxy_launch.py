"""Launching through a managed proxy, and the two per-profile kernel switches.

The account key must never reach the kernel's command line, so a launch trades
a proxy id for a short-lived ticket and hands over a ``relay://`` URL built from
that instead. A ticket that outlives its session is the failure worth guarding:
it is a live credential nobody will hand back.
"""

import json

import pytest

from antibrow import api as A
from antibrow import browser as B
from antibrow import kernel as K
from antibrow import license as L
from antibrow.errors import ProxyError

TICKET = A.ProxyTicket(
    ticket_id="t-1", username="mp-1", password="secret", host="relay.example.com", expires_at=None
)


@pytest.fixture
def fake_kernel(monkeypatch):
    exe_name = "chrome.exe" if K.current_platform() == "win32" else "chrome"

    def ensure(cache_dir, kv=None, on_progress=None, **kwargs):
        version = (kv or K.default_kernel_version()).version
        path = K.kernel_dir(cache_dir, version) / exe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        return path

    monkeypatch.setattr(B._kernel, "ensure_kernel", ensure)
    monkeypatch.setattr(B._kernel, "refresh_kernel_versions", lambda *a, **k: False)


@pytest.fixture
def free_license(monkeypatch):
    monkeypatch.setattr(
        B, "get_license_token", lambda *a, **k: L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=1, sync=False)
    )
    monkeypatch.setenv("ANTIBROW_API_KEY", "adb_test_key")


@pytest.fixture
def proxy_api(monkeypatch):
    """Record what the managed-proxy path asked the server for."""
    calls = {"activate": [], "issue": [], "revoke": []}

    def activate(key, server=None, *, proxy_id):
        calls["activate"].append(proxy_id)
        return A.ProxyActivation(allowed=True, proxy=A.ManagedProxy(id=proxy_id, protocol="http"))

    def issue(key, server=None, *, proxy_id, label=None, ttl_minutes=None):
        calls["issue"].append((proxy_id, label))
        return TICKET

    def revoke(key, server=None, *, proxy_id, ticket_id):
        calls["revoke"].append((proxy_id, ticket_id))

    monkeypatch.setattr(B._api, "activate_proxy", activate)
    monkeypatch.setattr(B._api, "issue_proxy_ticket", issue)
    monkeypatch.setattr(B._api, "revoke_proxy_ticket", revoke)
    return calls


def plan_for(tmp_path, **kwargs):
    options = {"cache_dir": tmp_path, "geoip": False, "profile": "p1"}
    options.update(kwargs)
    return B.prepare_launch(**options)


def switch(args, name):
    prefix = "--{0}=".format(name)
    return next((a[len(prefix):] for a in args if a.startswith(prefix)), None)


class TestManagedProxy:
    def test_activates_then_tickets_and_hands_the_kernel_a_relay_url(
        self, tmp_path, fake_kernel, free_license, proxy_api
    ):
        plan = plan_for(tmp_path, proxy_id="mp-1")

        # Activation first: that is what checks ownership and meters the quota.
        assert proxy_api["activate"] == ["mp-1"]
        assert proxy_api["issue"] == [("mp-1", "p1")]
        assert switch(plan.args, "proxy-server") == "relay://mp-1:secret@relay.example.com"
        assert plan.proxy_ticket.ticket_id == "t-1"

    def test_the_account_key_never_reaches_the_command_line(
        self, tmp_path, fake_kernel, free_license, proxy_api
    ):
        plan = plan_for(tmp_path, proxy_id="mp-1")

        assert not any("adb_test_key" in arg for arg in plan.args)

    def test_proxy_host_overrides_the_one_the_server_named(
        self, tmp_path, fake_kernel, free_license, proxy_api
    ):
        plan = plan_for(tmp_path, proxy_id="mp-1", proxy_host="proxy1.antibrow.com")

        assert switch(plan.args, "proxy-server").endswith("@proxy1.antibrow.com")

    def test_passing_both_a_proxy_and_a_proxy_id_is_refused(
        self, tmp_path, fake_kernel, free_license, proxy_api
    ):
        with pytest.raises(ValueError, match="not both"):
            plan_for(tmp_path, proxy_id="mp-1", proxy="http://u:p@host:8080")

        assert proxy_api["activate"] == []

    def test_a_failure_after_the_ticket_hands_it_straight_back(
        self, tmp_path, fake_kernel, free_license, proxy_api, monkeypatch
    ):
        # Nothing will ever close this session, so nothing else would revoke it -
        # and a retry loop against a flaky proxy would mint one live credential
        # per attempt.
        monkeypatch.setattr(B, "write_fp_config", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))

        with pytest.raises(OSError):
            plan_for(tmp_path, proxy_id="mp-1")

        assert proxy_api["revoke"] == [("mp-1", "t-1")]

    def test_no_managed_proxy_means_no_proxy_calls_at_all(self, tmp_path, fake_kernel, free_license, proxy_api):
        plan = plan_for(tmp_path)

        assert proxy_api == {"activate": [], "issue": [], "revoke": []}
        assert plan.proxy_ticket is None

    def test_activation_without_a_proxy_is_an_error_not_a_direct_launch(
        self, tmp_path, fake_kernel, free_license, monkeypatch
    ):
        monkeypatch.setattr(
            B._api, "activate_proxy", lambda *a, **k: A.ProxyActivation(allowed=True, proxy=None)
        )

        with pytest.raises(ProxyError):
            plan_for(tmp_path, proxy_id="mp-1")


class TestPerProfileSwitches:
    def read_config(self, plan):
        return json.loads((plan.profile_dir / "fp-config.json").read_text())

    def test_defaults_write_the_same_config_as_before_the_switches_existed(
        self, tmp_path, fake_kernel, free_license
    ):
        config = self.read_config(plan_for(tmp_path))

        assert config["apilog"] == {"enabled": False, "mode": "off", "path": ""}
        assert "mode" not in config["canvas"]
        assert "mode" not in config["webgl"]

    def test_canvas_noise_off_turns_off_canvas_and_webgl_together(
        self, tmp_path, fake_kernel, free_license
    ):
        config = self.read_config(plan_for(tmp_path, canvas_noise=False))

        assert config["canvas"]["mode"] == "off"
        assert config["webgl"]["mode"] == "off"
        # The seed stays: turning noise off does not change the identity.
        assert config["canvas"]["seed"]

    def test_canvas_noise_true_is_left_to_the_kernel_default(self, tmp_path, fake_kernel, free_license):
        # Writing "on" would make an unchanged profile read as changed.
        config = self.read_config(plan_for(tmp_path, canvas_noise=True))

        assert "mode" not in config["canvas"]

    def test_api_log_points_at_a_file_beside_the_profile(self, tmp_path, fake_kernel, free_license):
        plan = plan_for(tmp_path, api_log="curated")
        config = self.read_config(plan)

        assert config["apilog"]["enabled"] is True
        assert config["apilog"]["mode"] == "curated"
        assert config["apilog"]["path"] == str(plan.profile_dir / "fp-api-log.jsonl")
