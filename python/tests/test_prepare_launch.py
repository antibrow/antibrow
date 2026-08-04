"""End-to-end launch preparation, with the kernel and the server faked out.

``prepare_launch`` does everything a real launch does except starting the
process, so this is the closest we get to an integration test without a binary.
"""

from __future__ import annotations

import json

import pytest

from antibrow import browser as B
from antibrow import config as C
from antibrow import kernel as K
from antibrow import license as L
from antibrow.geoip import ProxyGeo


@pytest.fixture
def fake_kernel(tmp_path, monkeypatch):
    """Pretend the kernel for any version is already installed."""
    exe_name = "chrome.exe" if K.current_platform() == "win32" else "chrome"

    def ensure(cache_dir, kv=None, on_progress=None, **kwargs):
        version = (kv or K.default_kernel_version()).version
        path = K.kernel_dir(cache_dir, version) / exe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        return path

    monkeypatch.setattr(B._kernel, "ensure_kernel", ensure)
    return exe_name


@pytest.fixture
def fake_license(monkeypatch):
    info = L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=5, sync=False)
    monkeypatch.setattr(B, "get_license_token", lambda *a, **k: info)
    return info


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any real geo lookup in this file is a bug - make it loud.

    The manifest refresh that every launch now does is recorded instead of being
    banned, so tests can assert when it is forced. Returns that call log.
    """
    monkeypatch.setattr(
        B, "lookup_proxy_geo", lambda *a, **k: pytest.fail("unexpected network call")
    )
    refreshes = []

    def refresh(cache_dir, force=False, **kwargs):
        refreshes.append({"cache_dir": cache_dir, "force": force})
        return False

    monkeypatch.setattr(B._kernel, "refresh_kernel_versions", refresh)
    return refreshes


def plan_for(tmp_path, **kwargs):
    options = {"cache_dir": tmp_path, "geoip": False}
    options.update(kwargs)
    return B.prepare_launch(**options)


def test_plan_creates_the_profile_tree_and_wires_every_switch(tmp_path, fake_kernel, fake_license):
    plan = plan_for(tmp_path, profile="shopper-01")

    assert plan.profile_dir == tmp_path / "profiles" / "shopper-01"
    assert (plan.profile_dir / "persona.json").exists()
    assert (plan.profile_dir / "fp-config.json").exists()
    assert plan.user_data_dir.is_dir()
    assert plan.exe_path.name == fake_kernel
    assert plan.license.token == "PAYLOAD.SIG"
    assert plan.kernel_version == K.default_kernel_version().version

    joined = " ".join(plan.args)
    assert "--fp-config={0}".format(plan.profile_dir / "fp-config.json") in plan.args
    assert "--fp-license=PAYLOAD.SIG" in plan.args
    assert "--user-data-dir={0}".format(plan.user_data_dir) in plan.args
    assert "--fp-address-label=shopper-01" in plan.args
    assert "--remote-debugging-port={0}".format(plan.cdp_port) in joined
    assert 1024 < plan.cdp_port < 65536


def test_fp_config_on_disk_matches_the_persona_and_timezone(tmp_path, fake_kernel, fake_license):
    plan = plan_for(tmp_path, profile="p1", timezone="Europe/Berlin")
    config = json.loads((plan.profile_dir / "fp-config.json").read_text(encoding="utf-8"))
    assert config["timezone"] == "Europe/Berlin"
    assert config["navigator"]["userAgent"] == plan.persona.ua
    assert config["label"] == "p1"
    assert plan.timezone == "Europe/Berlin"


def test_same_profile_keeps_its_identity_across_launches(tmp_path, fake_kernel, fake_license):
    first = plan_for(tmp_path, profile="p1")
    second = plan_for(tmp_path, profile="p1")
    assert first.persona == second.persona
    # ... and a different profile gets its own directory.
    other = plan_for(tmp_path, profile="p2")
    assert other.profile_dir != first.profile_dir


def test_profile_names_are_sanitised_into_directory_names(tmp_path, fake_kernel, fake_license):
    plan = plan_for(tmp_path, profile="acct/../evil:name")
    assert plan.profile_dir.parent == tmp_path / "profiles"
    assert "/" not in plan.profile_dir.name and ":" not in plan.profile_dir.name


def test_explicit_profile_dir_wins_over_cache_dir(tmp_path, fake_kernel, fake_license):
    target = tmp_path / "somewhere" / "else"
    plan = plan_for(tmp_path, profile="ignored", profile_dir=target)
    assert plan.profile_dir == target
    assert plan.label == target.name


def test_kernel_version_pins_new_profiles_only(tmp_path, fake_kernel, fake_license, monkeypatch):
    # 149 is not compiled in any more: it reaches the catalogue the way the
    # manifest delivers it, which is also what makes it pinnable.
    monkeypatch.setattr(
        K,
        "_registered",
        [
            K.KernelVersion(
                "149.0.7827.201",
                "Chrome 149",
                {
                    K.current_platform(): K.KernelAsset(
                        "https://download.antibrow.com/fp-chromium-149-test.zip", "chrome"
                    )
                },
            )
        ],
    )
    old = plan_for(tmp_path, profile="pinned", kernel_version="149.0.7827.201")
    assert old.kernel_version == "149.0.7827.201"
    assert old.persona.chrome_major == 149
    assert "Chrome/149.0.0.0" in old.persona.ua

    # The profile now owns that version; a later default must not move it.
    again = plan_for(tmp_path, profile="pinned")
    assert again.kernel_version == "149.0.7827.201"


def test_label_defaults_to_the_profile_name_and_can_be_overridden(tmp_path, fake_kernel, fake_license):
    assert "--fp-address-label=p1" in plan_for(tmp_path, profile="p1").args
    plan = plan_for(tmp_path, profile="p1", label="acct@shop.com")
    assert "--fp-address-label=acct@shop.com" in plan.args
    config = json.loads((plan.profile_dir / "fp-config.json").read_text(encoding="utf-8"))
    assert config["label"] == "acct@shop.com"


def test_geoip_makes_the_timezone_follow_the_proxy(tmp_path, fake_kernel, fake_license, monkeypatch):
    monkeypatch.setattr(
        B,
        "lookup_proxy_geo",
        lambda *a, **k: ProxyGeo(ip="203.0.113.7", country="United States", timezone="America/Denver"),
    )
    plan = plan_for(
        tmp_path, profile="p1", proxy="http://u:p@gate.example.com:8080", geoip=True
    )
    assert plan.timezone == "America/Denver"
    assert plan.public_ip == "203.0.113.7"

    config = json.loads((plan.profile_dir / "fp-config.json").read_text(encoding="utf-8"))
    assert config["timezone"] == "America/Denver"
    # WebRTC must report the proxy exit, not the real local address.
    assert config["webrtc"] == {"mode": "passthrough", "publicIp": "203.0.113.7"}


def test_a_failed_geo_lookup_does_not_block_the_launch(tmp_path, fake_kernel, fake_license, monkeypatch):
    monkeypatch.setattr(B, "lookup_proxy_geo", lambda *a, **k: None)
    plan = plan_for(tmp_path, profile="p1", proxy="http://gate.example.com:8080", geoip=True)
    assert plan.timezone == plan.persona.timezone
    assert plan.public_ip is None


def test_explicit_timezone_beats_geoip(tmp_path, fake_kernel, fake_license, monkeypatch):
    monkeypatch.setattr(
        B, "lookup_proxy_geo", lambda *a, **k: ProxyGeo("1.2.3.4", "France", "Europe/Paris")
    )
    plan = plan_for(
        tmp_path, profile="p1", proxy="http://g:1", geoip=True, timezone="Asia/Tokyo"
    )
    assert plan.timezone == "Asia/Tokyo"
    assert plan.public_ip == "1.2.3.4"  # still used for WebRTC


def test_geoip_false_skips_the_lookup_entirely(tmp_path, fake_kernel, fake_license):
    # The autouse no_network fixture fails the test if a lookup happens.
    plan = plan_for(tmp_path, profile="p1", proxy="http://gate.example.com:8080", geoip=False)
    assert plan.public_ip is None


def test_secrets_are_redacted_for_logging(tmp_path, fake_kernel, fake_license):
    plan = plan_for(tmp_path, profile="p1", proxy="http://alice:s3cr3t@gate.example.com:8080")
    redacted = " ".join(plan.redacted_args())
    assert "PAYLOAD.SIG" not in redacted
    assert "s3cr3t" not in redacted
    assert "--fp-license=<redacted>" in redacted
    assert "--proxy-server=http://gate.example.com:8080" in redacted
    assert "shopper" not in repr(plan_for(tmp_path, profile="p1")) or True  # repr never raises


def test_every_launch_refreshes_the_catalogue_but_only_opt_in_forces_it(
    tmp_path, fake_kernel, fake_license, no_network
):
    # Kernels published after this release are only resolvable via the manifest,
    # so the default path refreshes too (cached inside refresh_kernel_versions).
    # update_kernel acts on the published build, so it must not read a stale cache.
    plan_for(tmp_path, profile="p1")
    assert [c["force"] for c in no_network] == [False]
    plan_for(tmp_path, profile="p1", update_kernel=True)
    assert [c["force"] for c in no_network] == [False, True]


def test_cache_dir_can_be_set_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv(C.ENV_CACHE_DIR, str(tmp_path / "custom"))
    assert C.default_cache_dir() == tmp_path / "custom"
    assert C.profiles_dir() == tmp_path / "custom" / "profiles"


def test_list_profiles_reports_what_is_on_disk(tmp_path, fake_kernel, fake_license):
    assert C.list_profiles(tmp_path) == []
    plan_for(tmp_path, profile="b-profile")
    plan_for(tmp_path, profile="a-profile")
    assert C.list_profiles(tmp_path) == ["a-profile", "b-profile"]


def test_passkey_store_is_wired_and_capture_is_opt_out(tmp_path, fake_kernel, fake_license):
    plan = plan_for(tmp_path, profile="p1")
    assert "--fp-webauthn-store={0}".format(plan.profile_dir / "passkeys.json") in plan.args
    assert "--fp-webauthn-create=choose" not in plan.args

    off = plan_for(tmp_path, profile="p2", webauthn_capture=False)
    assert "--fp-webauthn-create=choose" in off.args
