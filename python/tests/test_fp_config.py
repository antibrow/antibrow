"""fp-config.json is the contract with the kernel - its shape must not drift."""

from __future__ import annotations

import json

from antibrow.persona import (
    generate_persona,
    load_or_generate_persona,
    persona_to_fp_config,
    write_fp_config,
)


def config_for(persona=None, **kwargs):
    persona = persona or generate_persona(150, "150.0.7871.182")
    options = {"label": "profile-1", "timezone": "America/Los_Angeles"}
    options.update(kwargs)
    return persona, persona_to_fp_config(persona, **options)


def test_top_level_shape_matches_the_kernel_schema():
    _, config = config_for()
    assert config["version"] == 1
    for key in (
        "seed", "label", "timezone", "navigator", "screen", "webgl", "webgpu", "canvas",
        "audio", "domrect", "webrtc", "connection", "prefersColorScheme", "fonts", "apilog",
    ):
        assert key in config, key


def test_navigator_block_agrees_with_the_persona():
    persona, config = config_for()
    navigator = config["navigator"]
    assert navigator["userAgent"] == persona.ua
    assert navigator["platform"] == "Win32"  # must agree with the Windows UA
    assert navigator["vendor"] == "Google Inc."
    assert navigator["language"] == navigator["languages"][0] == "en-US"
    assert navigator["hardwareConcurrency"] == persona.hardware_concurrency
    assert navigator["deviceMemory"] == persona.device_memory
    assert navigator["maxTouchPoints"] == 0  # a desktop with touch points is a tell
    assert navigator["uaData"]["platformVersion"] == "15.0.0"  # Windows 11


def test_screen_block_is_internally_consistent():
    persona, config = config_for()
    screen = config["screen"]
    assert screen["width"] == persona.screen_w
    assert screen["availWidth"] == screen["width"]
    # availHeight is the screen minus the Windows taskbar, never taller than it.
    assert screen["availHeight"] == persona.screen_h - 48
    assert 0 < screen["availHeight"] < screen["height"]
    assert screen["colorDepth"] == screen["pixelDepth"] == 24
    assert screen["devicePixelRatio"] == persona.device_pixel_ratio


def test_seeds_are_carried_through_to_every_noise_dimension():
    persona, config = config_for()
    assert config["seed"] == persona.seed
    assert config["canvas"]["seed"] == persona.canvas_seed
    assert config["audio"]["seed"] == persona.audio_seed
    assert config["domrect"]["seed"] == persona.domrect_seed
    assert config["webgl"]["unmaskedVendor"] == persona.gpu_vendor
    assert config["webgl"]["unmaskedRenderer"] == persona.gpu_renderer


def test_webgpu_identity_matches_the_webgl_gpu():
    # navigator.gpu must name the GPU WebGL claims, not the real adapter.
    cases = {
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3699)":
            {"vendor": "nvidia", "architecture": ""},  # NVIDIA on D3D reports no architecture
        "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)":
            {"vendor": "amd", "architecture": "rdna-3"},
        "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101.4577)":
            {"vendor": "intel", "architecture": "gen-12lp"},
        "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9316)":
            {"vendor": "intel", "architecture": "gen-9"},
        "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)":
            {"vendor": "intel", "architecture": "xe-lpg"},
        # Unknown vendor: say nothing rather than guess.
        "SwiftShader": {},
    }
    persona = generate_persona(150, "150.0.7871.182")
    for renderer, expected in cases.items():
        persona.gpu_renderer = renderer
        _, config = config_for(persona)
        assert config["webgpu"] == expected, renderer

    # Every GPU we can roll must resolve, or our own personas would ship the
    # cross-API mismatch this field exists to prevent.
    for _ in range(40):
        _, config = config_for(generate_persona(150, "150.0.7871.182"))
        assert config["webgpu"] != {}


def test_webrtc_passes_the_proxy_ip_through_or_is_disabled():
    _, without = config_for()
    assert without["webrtc"] == {"mode": "disable"}

    _, with_ip = config_for(public_ip="203.0.113.7")
    assert with_ip["webrtc"] == {"mode": "passthrough", "publicIp": "203.0.113.7"}


def test_timezone_comes_from_the_launch_not_the_persona():
    persona = generate_persona(150, "150.0.7871.182")
    _, config = config_for(persona, timezone="Europe/Berlin")
    assert config["timezone"] == "Europe/Berlin"
    assert persona.timezone == "America/Los_Angeles"  # persona untouched


def test_color_scheme_is_deterministic_from_the_seed():
    persona = generate_persona(150, "150.0.7871.182")
    first = persona_to_fp_config(persona, label="a", timezone="UTC")["prefersColorScheme"]
    second = persona_to_fp_config(persona, label="b", timezone="UTC")["prefersColorScheme"]
    assert first == second
    assert first in ("light", "dark")

    persona.seed = "0" * 16  # sum of ord('0') * 16 = 768 -> 768 % 10 == 8 -> dark
    assert persona_to_fp_config(persona, label="a", timezone="UTC")["prefersColorScheme"] == "dark"
    persona.seed = "1" * 16  # 784 % 10 == 4 -> light
    assert persona_to_fp_config(persona, label="a", timezone="UTC")["prefersColorScheme"] == "light"


def test_color_scheme_distribution_is_roughly_seventy_thirty():
    dark = 0
    for _ in range(400):
        persona = generate_persona(150, "150.0.7871.182")
        if persona_to_fp_config(persona, label="x", timezone="UTC")["prefersColorScheme"] == "dark":
            dark += 1
    assert 0.15 < dark / 400 < 0.45


def test_fonts_block_keeps_the_windows_ui_font_and_no_cjk():
    _, config = config_for()
    assert config["fonts"] == {"uiFont": "Segoe UI", "keepCjk": 0, "block": [], "allow": []}


def test_api_logging_is_off_by_default():
    _, config = config_for()
    assert config["apilog"]["enabled"] is False


def test_write_fp_config_is_valid_json_on_disk(tmp_path):
    persona = load_or_generate_persona(tmp_path, "150.0.7871.182")
    path = write_fp_config(tmp_path, persona, label="shopper-01", timezone="Asia/Tokyo")
    assert path.name == "fp-config.json"
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["label"] == "shopper-01"
    assert written["timezone"] == "Asia/Tokyo"
    assert written["navigator"]["userAgent"] == persona.ua
