"""Port of oss/js/tests/engine/persona-macos.test.ts - keep the two in sync.

Both SDKs read the same fixture so a profile created by one launches the same
identity from the other.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from antibrow.persona import (
    MACOS_PERSONA_ON_FOREIGN_HOST,
    PERSONA_OS_INVALID,
    Persona,
    assert_persona_os,
    generate_persona,
    is_mac_persona,
    persona_host_warnings,
    persona_to_fp_config,
    sanitize_persona_gpu,
    with_kernel_version,
)

FIXTURES = Path(__file__).resolve().parents[2] / "js" / "tests" / "fixtures"
OPTS = dict(label="fixture", timezone="Europe/Berlin", public_ip="203.0.113.7", api_log_path="/p/fp-api-log.jsonl")


def _fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def mac_ua(major):
    return (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/{0}.0.0.0 Safari/537.36".format(major)
    )


def test_generates_a_mac_identity_that_leaves_hardware_to_the_host():
    p = generate_persona(153, "153", os="macos")
    assert p.os == "macos"
    assert p.ua == mac_ua(153)
    assert (p.gpu_vendor, p.gpu_renderer) == ("", "")
    assert (p.screen_w, p.screen_h, p.device_pixel_ratio, p.hardware_concurrency, p.device_memory) == (0, 0, 0, 0, 0)
    assert p.languages_pending is True
    assert p.to_dict()["os"] == "macos"


def test_windows_personas_carry_no_os_key():
    assert "os" not in generate_persona(153, "153").to_dict()
    assert "os" not in generate_persona(153, "153", os="windows").to_dict()


def test_invalid_combinations_raise():
    with pytest.raises(ValueError, match="os"):
        generate_persona(153, "153", os="linux")
    with pytest.raises(ValueError, match="desktop"):
        generate_persona(153, "153", os="macos", device_type="android")
    with pytest.raises(ValueError, match="(?i)real"):
        assert_persona_os("macos", None, real_fingerprint=True)


def test_kernel_switch_moves_only_the_chrome_major():
    moved = with_kernel_version(generate_persona(150, "150", os="macos"), "152")
    assert moved.ua == mac_ua(152)
    assert moved.os == "macos"


def test_gpu_guard_leaves_it_alone():
    p = generate_persona(153, "153", os="macos")
    assert sanitize_persona_gpu(p) is p


def test_host_warnings():
    mac = Persona.from_dict(_fixture("macos-persona.json"))
    assert persona_host_warnings(mac, "darwin") == []
    assert persona_host_warnings(mac, "win32") == [MACOS_PERSONA_ON_FOREIGN_HOST]
    assert persona_host_warnings(mac, "linux") == [MACOS_PERSONA_ON_FOREIGN_HOST]
    bad = Persona.from_dict({**_fixture("macos-persona.json"), "os": "mac"})
    assert persona_host_warnings(bad, "darwin") == [PERSONA_OS_INVALID]
    assert is_mac_persona(bad) is False


def test_fp_config_matches_the_js_fixture_on_every_host():
    mac = Persona.from_dict(_fixture("macos-persona.json"))
    for host in ("darwin", "win32", "linux"):
        assert persona_to_fp_config(mac, host_platform=host, **OPTS) == _fixture("macos-fp-config.json")


def test_noise_off_brings_no_webgl_surface():
    mac = Persona.from_dict(_fixture("macos-persona.json"))
    cfg = persona_to_fp_config(mac, canvas_noise=False, **OPTS)
    assert cfg["canvas"] == {"seed": "1111111111111111", "mode": "off"}
    assert cfg["webgl"] == {"mode": "off"}


def test_no_exit_ip_disables_webrtc():
    mac = Persona.from_dict(_fixture("macos-persona.json"))
    assert persona_to_fp_config(mac, label="x", timezone="UTC")["webrtc"] == {"mode": "disable"}
