"""Port of oss/js/tests/engine/persona-host-hardware.test.ts - keep the two in sync."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from antibrow.persona import (
    HOST_HARDWARE_UNAVAILABLE,
    MACOS_PERSONA_ON_FOREIGN_HOST,
    Persona,
    assert_persona_os,
    generate_persona,
    persona_host_warnings,
    persona_to_fp_config,
    sanitize_persona_gpu,
    uses_host_hardware,
    with_kernel_version,
)

FIXTURES = Path(__file__).resolve().parents[2] / "js" / "tests" / "fixtures"
OPTS = dict(label="fixture", timezone="Europe/Berlin", public_ip="203.0.113.7", api_log_path="/p/fp-api-log.jsonl")


def _fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def host_persona():
    return Persona.from_dict(_fixture("windows-host-persona.json"))


def test_generates_a_windows_persona_with_generated_hardware_values_marked_host():
    p = generate_persona(153, "153", hardware="host")
    assert p.hardware == "host"
    assert "os" not in p.to_dict()
    assert p.to_dict()["hardware"] == "host"
    assert "Windows NT 10.0" in p.ua
    assert p.hardware_concurrency > 0
    assert p.device_memory > 0
    assert p.screen_w > 0
    assert p.gpu_renderer != ""


def test_writes_no_hardware_key_for_generated_or_absent():
    assert "hardware" not in generate_persona(153, "153", hardware="generated").to_dict()
    assert "hardware" not in generate_persona(153, "153").to_dict()


def test_rejects_bad_hardware_arguments():
    with pytest.raises(ValueError, match="hardware"):
        generate_persona(153, "153", hardware="x")
    with pytest.raises(ValueError, match="desktop"):
        generate_persona(153, "153", hardware="host", device_type="android")
    with pytest.raises(ValueError, match="macOS"):
        generate_persona(153, "153", hardware="generated", os="macos")
    with pytest.raises(ValueError, match="(?i)real"):
        assert_persona_os(None, None, real_fingerprint=True, hardware="host")
    assert_persona_os("macos", None, hardware="host")


def test_sends_only_the_identity_whitelist_on_a_windows_host():
    out = persona_to_fp_config(host_persona(), host_platform="win32", **OPTS)
    assert out == _fixture("windows-host-fp-config.json")


@pytest.mark.parametrize("host", ["darwin", "linux"])
def test_falls_back_to_generated_hardware_on_a_foreign_host(host):
    p = host_persona()
    plain = replace(p, hardware=None)
    out = persona_to_fp_config(p, host_platform=host, **OPTS)
    assert out == persona_to_fp_config(plain, host_platform=host, **OPTS)
    assert out["navigator"]["platform"] == "Win32"
    assert "screen" in out
    assert "webgl" in out


def test_keeps_generating_hardware_for_a_windows_persona_without_the_field():
    plain = replace(host_persona(), hardware=None)
    out = persona_to_fp_config(plain, host_platform="win32", **OPTS)
    assert "screen" in out
    assert "webgl" in out


def test_turns_canvas_and_webgl_off_on_the_host_branch_when_canvas_noise_is_false():
    out = persona_to_fp_config(host_persona(), host_platform="win32", canvas_noise=False, **OPTS)
    assert out["canvas"]["mode"] == "off"
    assert out["webgl"] == {"mode": "off"}


def test_warns_only_for_host_hardware_on_a_non_windows_host():
    p = Persona.from_dict({**_fixture("windows-host-persona.json")})
    assert persona_host_warnings(p, "win32") == []
    assert persona_host_warnings(p, "darwin") == [HOST_HARDWARE_UNAVAILABLE]
    assert persona_host_warnings(p, "linux") == [HOST_HARDWARE_UNAVAILABLE]
    assert HOST_HARDWARE_UNAVAILABLE == "host-hardware-unavailable"
    assert persona_host_warnings(replace(p, hardware=None), "darwin") == []
    assert persona_host_warnings(replace(p, hardware="bogus"), "darwin") == []
    mac = Persona.from_dict(_fixture("macos-persona.json"))
    assert persona_host_warnings(mac, "win32") == [MACOS_PERSONA_ON_FOREIGN_HOST]
    assert persona_host_warnings(mac, "darwin") == []


def test_reports_who_uses_host_hardware():
    p = host_persona()
    assert uses_host_hardware(Persona.from_dict(_fixture("macos-persona.json"))) is True
    assert uses_host_hardware(p) is True
    assert uses_host_hardware(replace(p, hardware=None)) is False
    assert uses_host_hardware(replace(p, device_type="android")) is False


def test_keeps_hardware_across_a_kernel_switch():
    moved = with_kernel_version(host_persona(), "152")
    assert moved.hardware == "host"
    assert "Chrome/152" in moved.ua


def test_still_repairs_a_blocked_gpu_vendor():
    p = replace(host_persona(), gpu_vendor="Imagination Technologies")
    assert sanitize_persona_gpu(p).gpu_vendor == "ARM"
