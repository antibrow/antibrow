"""The blocked ANGLE vendor token must never reach a profile, new or old."""

from __future__ import annotations

import copy
import json

from antibrow.android_devices import ANDROID_FALLBACK_DEVICES
from antibrow.persona import (
    PERSONA_FILE,
    generate_persona,
    load_or_generate_persona,
    sanitize_persona_gpu,
)

TAINTED_VENDOR = "Google Inc. (Imagination Technologies)"
TAINTED_RENDERER = (
    "ANGLE (Imagination Technologies, PowerVR Rogue GE8322, OpenGL ES 3.2 build 1.13@5776728)"
)


def tainted_device():
    device = copy.deepcopy(ANDROID_FALLBACK_DEVICES[0])
    device["webgl"]["unmaskedVendor"] = TAINTED_VENDOR
    device["webgl"]["unmaskedRenderer"] = TAINTED_RENDERER
    return device


def test_device_row_loses_the_vendor_but_keeps_the_model():
    persona = generate_persona(151, "151", device=tainted_device())
    assert persona.gpu_vendor == "Google Inc. (ARM)"
    assert persona.gpu_renderer == (
        "ANGLE (ARM, PowerVR Rogue GE8322, OpenGL ES 3.2 build 1.13@5776728)"
    )


def test_clean_persona_is_returned_unchanged():
    persona = generate_persona(151, "151", device_type="android")
    assert sanitize_persona_gpu(persona) is persona


def test_only_the_two_gpu_strings_move():
    persona = generate_persona(151, "151", device_type="android")
    persona.gpu_vendor = TAINTED_VENDOR
    before = persona.to_dict()
    after = sanitize_persona_gpu(persona).to_dict()
    assert after.pop("gpuVendor") == "Google Inc. (ARM)"
    before.pop("gpuVendor")
    assert after == before


def test_existing_profile_is_repaired_and_persisted(tmp_path):
    persona = generate_persona(151, "151", device_type="android")
    persona.gpu_vendor = TAINTED_VENDOR
    persona.gpu_renderer = TAINTED_RENDERER
    (tmp_path / PERSONA_FILE).write_text(json.dumps(persona.to_dict(), indent=2), encoding="utf-8")

    loaded = load_or_generate_persona(tmp_path, "151")
    assert loaded.gpu_vendor == "Google Inc. (ARM)"
    assert loaded.gpu_renderer.startswith("ANGLE (ARM, PowerVR Rogue GE8322")
    assert loaded.seed == persona.seed

    on_disk = json.loads((tmp_path / PERSONA_FILE).read_text(encoding="utf-8"))
    assert on_disk["gpuVendor"] == "Google Inc. (ARM)"
    assert on_disk["gpuRenderer"] == loaded.gpu_renderer


def test_clean_profile_is_not_rewritten(tmp_path):
    persona = generate_persona(151, "151", device_type="android")
    path = tmp_path / PERSONA_FILE
    path.write_text(json.dumps(persona.to_dict(), indent=2), encoding="utf-8")
    before = path.stat().st_mtime_ns

    load_or_generate_persona(tmp_path, "151")

    assert path.stat().st_mtime_ns == before
