"""fp-config.json is the contract with the kernel - its shape must not drift."""

from __future__ import annotations

import json

from antibrow.persona import (
    CapturedFacts,
    generate_persona,
    load_or_generate_persona,
    persona_to_fp_config,
    write_fp_config,
)


def config_for(persona=None, **kwargs):
    persona = persona or generate_persona(150, "150.0.0.0")
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


def test_ua_data_supplies_the_full_uach_group_so_nothing_falls_back_to_the_real_host():
    # Any key missing here means the kernel falls back to the real host value
    # for that key - exactly the leak this test guards against.
    _, config = config_for()
    assert config["navigator"]["uaData"] == {
        "platform": "Windows",  # UA-CH naming, not navigator.platform's "Win32"
        "platformVersion": "15.0.0",
        "architecture": "x86",  # UA-CH reports x86 even on x64 hardware
        "bitness": "64",
        "wow64": False,
        "model": "",
    }


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
    persona = generate_persona(150, "150.0.0.0")
    for renderer, expected in cases.items():
        persona.gpu_renderer = renderer
        _, config = config_for(persona)
        assert config["webgpu"] == expected, renderer

    # Every GPU we can roll must resolve, or our own personas would ship the
    # cross-API mismatch this field exists to prevent.
    for _ in range(40):
        _, config = config_for(generate_persona(150, "150.0.0.0"))
        assert config["webgpu"] != {}


def test_webrtc_passes_the_proxy_ip_through_or_is_disabled():
    _, without = config_for()
    assert without["webrtc"] == {"mode": "disable"}

    _, with_ip = config_for(public_ip="203.0.113.7")
    assert with_ip["webrtc"] == {"mode": "passthrough", "publicIp": "203.0.113.7"}


def test_timezone_comes_from_the_launch_not_the_persona():
    persona = generate_persona(150, "150.0.0.0")
    _, config = config_for(persona, timezone="Europe/Berlin")
    assert config["timezone"] == "Europe/Berlin"
    assert persona.timezone == "America/Los_Angeles"  # persona untouched


def test_color_scheme_is_deterministic_from_the_seed():
    persona = generate_persona(150, "150.0.0.0")
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
        persona = generate_persona(150, "150.0.0.0")
        if persona_to_fp_config(persona, label="x", timezone="UTC")["prefersColorScheme"] == "dark":
            dark += 1
    assert 0.15 < dark / 400 < 0.45


#: The Windows font whitelist the kernel is told to allow-list. An empty
#: `allow` hides nothing, which is precisely how macOS/Linux system fonts
#: leaked through on a non-Windows host - so this must stay the full set.
EXPECTED_FONT_ALLOWLIST = [
    "Arial",
    "Arial Black",
    "Bahnschrift",
    "Calibri",
    "Cambria",
    "Cambria Math",
    "Candara",
    "Comic Sans MS",
    "Consolas",
    "Constantia",
    "Corbel",
    "Courier New",
    "Ebrima",
    "Franklin Gothic Medium",
    "Gabriola",
    "Gadugi",
    "Georgia",
    "Impact",
    "Ink Free",
    "Javanese Text",
    "Leelawadee UI",
    "Lucida Console",
    "Lucida Sans Unicode",
    "MV Boli",
    "Marlett",
    "Microsoft Sans Serif",
    "Palatino Linotype",
    "Segoe Print",
    "Segoe Script",
    "Segoe UI",
    "Segoe UI Emoji",
    "Segoe UI Symbol",
    "Sitka",
    "Sylfaen",
    "Symbol",
    "Tahoma",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
    "Webdings",
    "Wingdings",
]

#: Generic CSS family mapping. Absent entirely, generic families resolve
#: through the host's own settings to host fonts - a second way system fonts
#: used to leak through a Windows persona on a non-Windows host. Every entry
#: names a second, more widely installed family: a generic that resolves to
#: nothing measures like a family nobody has.
EXPECTED_FONT_GENERIC = {
    "standard": "Times New Roman,Georgia",
    "serif": "Times New Roman,Georgia",
    "sansSerif": "Arial,Verdana",
    "cursive": "Comic Sans MS,Trebuchet MS",
    "fantasy": "Impact,Arial Black",
    "monospace": "Consolas,Courier New",
    "math": "Cambria Math,Times New Roman,Georgia",
}

#: Windows-exclusive and with no stand-in: unrenderable on any other host.
NEVER_ON_A_FOREIGN_HOST = [
    "Bahnschrift", "Candara", "Constantia", "Corbel", "Gabriola", "Gadugi",
    "Ink Free", "Javanese Text", "Leelawadee UI", "Lucida Console",
    "Lucida Sans Unicode", "MV Boli", "Marlett", "Palatino Linotype",
    "Segoe Print", "Segoe Script", "Segoe UI Emoji", "Sitka", "Symbol",
]

# The families a detector expects a Windows machine to measure. Each has a
# stand-in, so each must produce its own width rather than the one a family
# nobody installed produces.
SIGNATURE_FAMILIES_WITH_A_STAND_IN = [
    "Segoe UI", "Calibri", "Cambria", "Consolas", "Sylfaen",
    "Franklin Gothic Medium", "Ebrima",
]


def test_fonts_block_keeps_the_windows_ui_font_and_no_cjk():
    _, config = config_for()
    assert config["fonts"]["uiFont"] == "Segoe UI"
    assert config["fonts"]["keepCjk"] == 0
    assert config["fonts"]["block"] == []


def test_fonts_allow_is_the_full_windows_font_whitelist():
    # Must fail if `allow` ever goes back to empty - an empty allowlist hides
    # nothing and is exactly the bug that let macOS system fonts enumerate.
    # Pinned to a Windows host: `allow` now depends on the host, so an unpinned
    # call says something different on each CI runner.
    _, config = config_for(host_platform="win32")
    assert config["fonts"]["allow"] == EXPECTED_FONT_ALLOWLIST


def test_fonts_allow_drops_what_a_foreign_host_can_never_render():
    # Keeping them would have the enumerable set claim a font the measured set
    # reports as absent - one browser contradicting itself.
    _, config = config_for(host_platform="darwin")
    allow = config["fonts"]["allow"]
    for family in NEVER_ON_A_FOREIGN_HOST:
        assert family not in allow
    # The aliased families stay: a stand-in renders them with Windows metrics.
    for family in (*SIGNATURE_FAMILIES_WITH_A_STAND_IN, "Segoe UI Symbol", "Cambria Math"):
        assert family in allow
    # So do the ones another desktop OS plausibly ships.
    for family in ("Arial", "Georgia", "Times New Roman", "Verdana", "Tahoma"):
        assert family in allow


def test_fonts_generic_maps_every_css_generic_family():
    # Must fail if any of the seven keys disappears - a missing key falls
    # through to the host's generic-family fonts.
    _, config = config_for(host_platform="win32")
    assert config["fonts"]["generic"] == EXPECTED_FONT_GENERIC
    assert set(config["fonts"]["generic"].keys()) == {
        "standard", "serif", "sansSerif", "cursive", "fantasy", "monospace", "math",
    }


def test_api_logging_is_off_by_default():
    _, config = config_for()
    assert config["apilog"]["enabled"] is False


def test_write_fp_config_is_valid_json_on_disk(tmp_path):
    persona = load_or_generate_persona(tmp_path, "150.0.0.0")
    path = write_fp_config(tmp_path, persona, label="shopper-01", timezone="Asia/Tokyo")
    assert path.name == "fp-config.json"
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["label"] == "shopper-01"
    assert written["timezone"] == "Asia/Tokyo"
    assert written["navigator"]["userAgent"] == persona.ua


# A persona imported from a real-device capture replays that machine's WebGL
# report verbatim; a synthesized report next to captured GPU strings is exactly
# the kind of disagreement a scanner looks for.


def test_a_captured_webgl_report_is_replayed_verbatim():
    persona = generate_persona(150, "150.0.0.0")
    persona.captured_webgl = {
        "VERSION": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
        "SHADING_LANGUAGE_VERSION": "WebGL GLSL ES 1.0",
        "params": {"MAX_TEXTURE_SIZE": 16384},
        "shaderPrecision": {"VERTEX_HIGH_FLOAT": [127, 127, 23], "broken": [1, 2]},
    }

    webgl = persona_to_fp_config(persona, label="p", timezone="UTC")["webgl"]

    assert webgl["version"] == "WebGL 1.0 (OpenGL ES 2.0 Chromium)"
    assert webgl["shadingLanguageVersion"] == "WebGL GLSL ES 1.0"
    assert webgl["params"] == {"MAX_TEXTURE_SIZE": 16384}
    # Triples become "min,max,precision"; a malformed entry is dropped.
    assert webgl["shaderPrecision"] == {"VERTEX_HIGH_FLOAT": "127,127,23"}
    # The GPU strings still come from the persona.
    assert webgl["unmaskedRenderer"] == persona.gpu_renderer


def test_a_persona_without_a_capture_falls_back_to_the_windows_gl_surface():
    # Leaving these out spoofs the two unmasked strings and lets every limit,
    # precision range and extension keep describing the host GPU - a persona
    # claiming D3D11 while answering with Metal numbers.
    _, config = config_for()
    webgl = config["webgl"]
    assert webgl["params"]["3379"] == 16384
    assert webgl["shaderPrecision"]["35632-36336"] == "127,127,23"
    assert "WEBGL_compressed_texture_s3tc" in webgl["extensions"]["allow"]
    # The kernel wraps the webgl2 pair itself; sending the wrapped form back
    # yields "WebGL 2.0 (WebGL 2.0 (...))".
    assert webgl["version2"] == "OpenGL ES 3.0 Chromium"


def test_max_vertex_uniform_vectors_follows_the_gpu_vendor():
    # The one D3D11 value that splits by vendor: NVIDIA reports one fewer.
    persona, _ = config_for()
    persona.gpu_vendor = "Google Inc. (NVIDIA)"
    nvidia = persona_to_fp_config(persona, label="x", timezone="UTC")["webgl"]
    persona.gpu_vendor = "Google Inc. (AMD)"
    amd = persona_to_fp_config(persona, label="x", timezone="UTC")["webgl"]
    assert nvidia["params"]["36347"] == 4095
    assert amd["params"]["36347"] == 4096


def test_a_captured_report_survives_persona_json(tmp_path):
    persona = generate_persona(150, "150.0.0.0")
    persona.captured_webgl = {"VERSION": "WebGL 1.0"}
    from antibrow.persona import write_persona

    write_persona(tmp_path, persona)

    assert load_or_generate_persona(tmp_path, "150.0.0.0").captured_webgl == {"VERSION": "WebGL 1.0"}


# A replayed real device brings an open-ended font list - whatever that machine
# happened to have installed. The filter must hold for names nobody enumerated
# in advance, or the profile claims families the host has no glyphs for and
# every one of them measures as the same fallback width.
CAPTURED_WINDOWS_FONTS = [
    "Arial", "Segoe UI", "Georgia", "Verdana", "Tahoma",
    "Consolas", "Sylfaen", "Ebrima", "Franklin Gothic Medium",
    "MS Gothic", "SimSun", "Microsoft YaHei", "Malgun Gothic", "Yu Gothic",
    "Segoe MDL2 Assets", "HoloLens MDL2 Assets", "Montserrat",
]


def captured_config_for(host_platform, fonts=None):
    persona = generate_persona(150, "150.0.0.0")
    persona.captured = CapturedFacts(fonts=list(fonts or CAPTURED_WINDOWS_FONTS))
    _, config = config_for(persona, host_platform=host_platform)
    return config


def test_captured_fonts_drop_what_a_foreign_host_cannot_render():
    allow = captured_config_for("darwin")["fonts"]["allow"]
    # Stand-in fonts ship with the kernel, so these render with Windows metrics.
    for family in ("Arial", "Segoe UI"):
        assert family in allow
    # macOS ships these under the same family name.
    for family in ("Georgia", "Verdana", "Tahoma"):
        assert family in allow
    # A stand-in keeps these enumerable and measurable.
    for family in ("Consolas", "Sylfaen", "Ebrima", "Franklin Gothic Medium"):
        assert family in allow
    # No stand-in and no host glyphs. The CJK and icon families are the ones the
    # hand-written Windows-only list never covered.
    for family in (
        "MS Gothic", "SimSun", "Microsoft YaHei", "Malgun Gothic", "Yu Gothic",
        "Segoe MDL2 Assets", "HoloLens MDL2 Assets", "Montserrat",
    ):
        assert family not in allow


def test_captured_fonts_are_replayed_verbatim_on_a_windows_host():
    assert captured_config_for("win32")["fonts"]["allow"] == CAPTURED_WINDOWS_FONTS


def test_captured_fonts_never_empty_allow():
    # An empty allow switches the kernel back to hiding nothing.
    allow = captured_config_for("darwin", ["Sylfaen", "Ebrima", "MS Gothic"])["fonts"]["allow"]
    assert allow
