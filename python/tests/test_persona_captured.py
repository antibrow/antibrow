"""Port of oss/js/tests/engine/persona-captured.test.ts - keep the two in sync.

The desktop baseline matters here, not just the assertions: ``architecture``
defaults to ``"x86"`` and ``bitness`` to ``"64"``, so overlaying captured
``""`` is only observable if the guard is genuinely ``is not None`` rather
than truthy. An Android baseline would not catch a regression to truthiness,
because its own defaults already are ``""``/``True`` for these fields.
"""

from __future__ import annotations

from antibrow.persona import CapturedFacts, Persona, generate_persona, persona_to_fp_config


def desktop_persona() -> Persona:
    persona = generate_persona(150, "150.0.7871.182")
    persona.seed = "0123456789abcdef"
    persona.screen_w = 1536
    persona.screen_h = 864
    return persona


def test_capturedwebgl_carries_the_webgl2_version_strings_through():
    persona = desktop_persona()
    persona.captured_webgl = {
        "VERSION": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
        "SHADING_LANGUAGE_VERSION": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
        "VERSION2": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
        "SHADING_LANGUAGE_VERSION2": "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
        "params": {"3379": 16384},
        "shaderPrecision": {"35632-36336": [15, 15, 10]},
    }
    webgl = persona_to_fp_config(persona, label="x", timezone="UTC")["webgl"]
    assert webgl["version"] == "WebGL 1.0 (OpenGL ES 2.0 Chromium)"
    assert webgl["version2"] == "WebGL 2.0 (OpenGL ES 3.0 Chromium)"
    assert webgl["shadingLanguageVersion2"] == "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)"
    assert webgl["params"] == {"3379": 16384}
    assert webgl["shaderPrecision"] == {"35632-36336": "15,15,10"}


def test_captured_facts_replace_navigator_screen_audio_connection_and_fonts():
    persona = desktop_persona()
    persona.captured = CapturedFacts(
        platform="Linux armv8l",
        vendor="Captured Vendor Inc.",
        max_touch_points=10,
        color_depth=30,
        avail_w=1530,
        avail_h=800,
        prefers_color_scheme="dark",
        connection_effective_type="3g",
        connection_rtt=350,
        connection_downlink=1.2,
        connection_type="wifi",
        connection_downlink_max=0,
        ua_platform="Chrome OS",
        ua_platform_version="10.0.19045",
        ua_architecture="x86",
        ua_bitness="64",
        ua_model="",
        ua_mobile=False,
        audio_sample_rate=44100,
        audio_max_channel_count=2,
        fonts=["Arial", "Verdana"],
        webgl_extensions=["EXT_sRGB", "OES_texture_float"],
    )
    config = persona_to_fp_config(persona, label="x", timezone="UTC")
    nav = config["navigator"]
    screen = config["screen"]

    assert nav["platform"] == "Linux armv8l"
    assert nav["vendor"] == "Captured Vendor Inc."
    assert nav["maxTouchPoints"] == 10
    assert nav["uaData"]["platform"] == "Chrome OS"
    assert nav["uaData"]["platformVersion"] == "10.0.19045"
    assert screen["availWidth"] == 1530
    assert screen["availHeight"] == 800
    assert screen["colorDepth"] == 30
    assert screen["pixelDepth"] == 30
    assert config["prefersColorScheme"] == "dark"
    # type and downlinkMax are absent from the generated connection block, so
    # this also proves connection_downlink_max=0 (falsy) still lands - it is
    # one of the `is not None` fields.
    assert config["connection"] == {
        "effectiveType": "3g",
        "rtt": 350,
        "downlink": 1.2,
        "type": "wifi",
        "downlinkMax": 0,
    }
    assert config["audio"] == {"seed": persona.audio_seed, "sampleRate": 44100, "maxChannelCount": 2}
    assert config["fonts"]["allow"] == ["Arial", "Verdana"]
    assert config["webgl"]["extensions"] == {"allow": ["EXT_sRGB", "OES_texture_float"]}


def test_a_field_that_was_not_captured_is_left_alone():
    persona = desktop_persona()
    persona.captured = CapturedFacts(max_touch_points=3)
    config = persona_to_fp_config(persona, label="x", timezone="UTC")
    assert config["navigator"]["maxTouchPoints"] == 3
    assert config["screen"]["availHeight"] == 816
    assert config["screen"]["colorDepth"] == 24
    assert config["fonts"]["uiFont"] == "Segoe UI"


def test_empty_string_and_false_are_real_captured_values_not_unset():
    persona = desktop_persona()
    persona.captured = CapturedFacts(ua_architecture="", ua_bitness="", ua_model="", ua_mobile=False)
    ua_data = persona_to_fp_config(persona, label="x", timezone="UTC")["navigator"]["uaData"]
    # Desktop defaults are "x86" / "64" / no "mobile" key at all: a guard that
    # regressed from `is not None` to truthiness would silently keep those
    # defaults instead, and every assertion below would fail.
    assert ua_data["architecture"] == ""
    assert ua_data["bitness"] == ""
    assert ua_data["model"] == ""
    assert ua_data["mobile"] is False
