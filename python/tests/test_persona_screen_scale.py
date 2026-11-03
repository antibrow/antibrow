"""screen_scale picks a self-consistent screen; "host" defers to the real display."""

from __future__ import annotations

import json
import math

import pytest

from antibrow import kernel as K
from antibrow import portable as P
from antibrow.persona import Persona, generate_persona, persona_to_fp_config, with_screen_scale, write_persona

PHYSICAL = {"1920x1080", "1366x768", "1600x900", "2560x1440", "1920x1200", "2560x1600"}


@pytest.mark.parametrize("scale", [100, 125, 150])
def test_scale_pins_the_dpr_and_a_real_panel(scale):
    for _ in range(40):
        p = generate_persona(153, "153", screen_scale=scale)
        assert p.device_pixel_ratio == scale / 100
        # Chrome rounds 2560/1.5 up to 1707, so floor recovers the panel.
        size = "{0}x{1}".format(math.floor(p.screen_w * p.device_pixel_ratio), math.floor(p.screen_h * p.device_pixel_ratio))
        assert size in PHYSICAL
        assert not p.host_screen


def test_host_omits_the_screen_block_and_round_trips():
    p = generate_persona(153, "153", screen_scale="host")
    assert p.host_screen and p.screen_w > 0
    assert p.to_dict()["hostScreen"] is True
    assert Persona.from_dict(p.to_dict()).host_screen
    assert "screen" not in persona_to_fp_config(p, label="x", timezone="UTC", host_platform="darwin")
    scaled = generate_persona(153, "153", screen_scale=125)
    assert "hostScreen" not in scaled.to_dict()
    assert persona_to_fp_config(scaled, label="x", timezone="UTC", host_platform="darwin")["screen"]["devicePixelRatio"] == 1.25


@pytest.mark.parametrize(
    "kwargs",
    [
        {"screen_scale": 110},
        {"screen_scale": True},
        {"screen_scale": 125, "os": "macos"},
        {"screen_scale": 125, "hardware": "host"},
        {"screen_scale": "host", "device_type": "android"},
    ],
)
def test_rejects_screens_that_are_not_generated(kwargs):
    with pytest.raises(ValueError, match="screen_scale"):
        generate_persona(153, "153", **kwargs)


def test_host_screen_survives_a_portable_round_trip(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    write_persona(source, generate_persona(150, K.default_kernel_version().version, screen_scale="host"))
    dest = tmp_path / "dst"
    P.import_profile_archive(P.export_profile_archive(source, P.PortableProfileMeta(name="n")), dest)
    assert json.loads((dest / "persona.json").read_text())["hostScreen"] is True


def test_with_screen_scale_moves_only_the_screen():
    p = generate_persona(153, "153", screen_scale="host")
    moved = with_screen_scale(p, 100)
    assert moved.device_pixel_ratio == 1 and not moved.host_screen
    def strip(d):
        return {k: v for k, v in d.items() if k not in ("screenW", "screenH", "devicePixelRatio", "hostScreen")}

    assert strip(moved.to_dict()) == strip(p.to_dict())
    assert with_screen_scale(moved, "host").host_screen
    with pytest.raises(ValueError, match="screen_scale"):
        with_screen_scale(generate_persona(153, "153", hardware="host"), 125)
    with pytest.raises(ValueError, match="screen_scale"):
        with_screen_scale(generate_persona(153, "153", device_type="android"), 125)
