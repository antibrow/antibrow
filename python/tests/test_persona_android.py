from antibrow.android_devices import ANDROID_FALLBACK_DEVICES
from antibrow.persona import (
    device_to_persona_parts,
    generate_persona,
    persona_to_fp_config,
)


def test_bundled_devices_are_whole_rows():
    assert [d["model"] for d in ANDROID_FALLBACK_DEVICES] == ["SM-S918U", "moto g05", "SM-S936U"]
    for device in ANDROID_FALLBACK_DEVICES:
        assert device["navigator"]["platform"] == "Linux armv81"
        assert device["navigator"]["maxTouchPoints"] == 5
        assert device["navigator"]["uaData"]["mobile"] is True
        assert device["navigator"]["uaData"]["architecture"] == ""
        assert len(device["webgl"]["extensions"]) > 20
        assert "{major}" in device["ua"]


def test_android_persona_replays_one_device():
    persona = generate_persona(151, "151.0.0.0", device_type="android")
    assert persona.device_type == "android"
    source = next(d for d in ANDROID_FALLBACK_DEVICES if d["model"] == persona.android_model)
    assert persona.screen_w == source["screen"]["width"]
    assert persona.gpu_renderer == source["webgl"]["unmaskedRenderer"]
    assert persona.captured.max_touch_points == 5
    assert persona.captured.ua_architecture == ""
    assert persona.captured_webgl["VERSION2"].startswith("WebGL 2.0")
    assert "Chrome/151.0.0.0 Mobile Safari" in persona.ua


def test_android_os_major_varies_in_range():
    seen = {generate_persona(151, "151.0.0.0", device_type="android").android_os_major for _ in range(200)}
    assert sorted(seen) == [13, 14, 15, 16]


def test_desktop_generation_is_untouched():
    persona = generate_persona(150, "150.0.0.0")
    assert persona.device_type is None
    assert persona.captured is None


def test_android_fp_config():
    persona = generate_persona(151, "151.0.0.0", device_type="android")
    config = persona_to_fp_config(persona, label="demo", timezone="America/Los_Angeles")
    assert config["device"] == {
        "type": "android",
        "pointer": "coarse",
        "hover": "none",
        "viewport": "mobile",
        "orientation": "portrait-primary",
        "outerWidth": persona.screen_w,
        "outerHeight": persona.screen_h,
    }
    nav = config["navigator"]
    assert nav["platform"] == "Linux armv81"
    assert nav["maxTouchPoints"] == 5
    assert nav["uaData"]["mobile"] is True
    assert nav["uaData"]["architecture"] == ""
    assert nav["uaData"]["bitness"] == ""
    assert nav["uaData"]["model"] == persona.android_model
    assert nav["uaData"]["platformVersion"] == "{0}.0.0".format(persona.android_os_major)
    assert config["fonts"]["uiFont"] == "Roboto"
    source = next(d for d in ANDROID_FALLBACK_DEVICES if d["model"] == persona.android_model)
    assert config["screen"]["availHeight"] == source["screen"]["availHeight"]


def test_desktop_fp_config_has_no_device_key():
    config = persona_to_fp_config(
        generate_persona(150, "150.0.0.0"), label="demo", timezone="UTC"
    )
    assert "device" not in config


def test_device_to_persona_parts_normalizes_webgl_keys():
    parts = device_to_persona_parts(ANDROID_FALLBACK_DEVICES[0], 151, 15)
    assert parts["captured_webgl"]["VERSION"] == ANDROID_FALLBACK_DEVICES[0]["webgl"]["version"]
    assert parts["captured_webgl"]["SHADING_LANGUAGE_VERSION2"] == ANDROID_FALLBACK_DEVICES[0]["webgl"]["shadingLanguageVersion2"]
    assert parts["captured"].ua_platform_version == "15.0.0"
