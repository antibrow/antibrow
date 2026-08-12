"""Persona generation must be self-consistent and, once written, frozen."""

from __future__ import annotations

import json
import random
import re

import pytest

from antibrow.persona import (
    DEVICE_MEMORY,
    GPUS,
    HARDWARE_CONCURRENCY,
    SCREENS,
    Persona,
    chrome_major_of,
    generate_persona,
    load_or_generate_persona,
    write_persona,
)

HEX16 = re.compile(r"^[0-9a-f]{16}$")


def personas(count=60, kernel_version="150.0.0.0"):
    major = chrome_major_of(kernel_version)
    return [generate_persona(major, kernel_version) for _ in range(count)]


def test_seeds_are_16_hex_chars_and_distinct_per_persona():
    for persona in personas(30):
        for seed in (persona.seed, persona.canvas_seed, persona.audio_seed, persona.domrect_seed):
            assert HEX16.match(seed), seed
        # Four independent seeds: a shared one would let a site correlate the
        # canvas and audio noise back to a single identity.
        assert len({persona.seed, persona.canvas_seed, persona.audio_seed, persona.domrect_seed}) == 4


def test_user_agent_matches_the_kernel_major():
    # The tails must differ from the frozen ".0.0.0" the UA carries, or the
    # expected substring is character-identical to the input and a UA built from
    # the whole version string instead of the major would still match.
    for version in ("150.7.7.7", "149.7.7.7"):
        persona = generate_persona(chrome_major_of(version), version)
        assert persona.chrome_major == int(version.split(".")[0])
        assert "Chrome/{0}.0.0.0".format(persona.chrome_major) in persona.ua
        assert persona.kernel_version == version
        # Windows persona: the UA platform token must agree with fp-config's
        # navigator.platform ("Win32") that the kernel reports.
        assert "Windows NT 10.0; Win64; x64" in persona.ua


def test_picked_values_come_from_the_curated_pools():
    screens = {(w, h, d) for w, h, d in SCREENS}
    gpus = {(vendor, renderer) for vendor, renderer in GPUS}
    for persona in personas():
        assert (persona.screen_w, persona.screen_h, persona.device_pixel_ratio) in screens
        assert (persona.gpu_vendor, persona.gpu_renderer) in gpus
        assert persona.hardware_concurrency in HARDWARE_CONCURRENCY
        assert persona.device_memory in DEVICE_MEMORY


def test_gpu_vendor_and_renderer_never_contradict():
    for persona in personas():
        vendor_word = persona.gpu_vendor.split("(")[1].rstrip(")")  # Intel / NVIDIA / AMD
        assert vendor_word in persona.gpu_renderer


def test_device_pixel_ratio_is_never_one():
    # dpr == 1 both looks like a VM and disables the kernel's DOMRect noise.
    for persona in personas():
        assert persona.device_pixel_ratio != 1


def test_generation_is_reproducible_with_a_seeded_rng():
    a = generate_persona(150, "150.0.0.0", rng=random.Random(1234))
    b = generate_persona(150, "150.0.0.0", rng=random.Random(1234))
    assert a == b


def test_persona_round_trips_through_camel_case_json():
    persona = generate_persona(150, "150.0.0.0")
    data = persona.to_dict()
    # camelCase keys keep the file readable by the Node SDK and the desktop app.
    assert set(data) == {
        "seed", "canvasSeed", "audioSeed", "domrectSeed", "chromeMajor", "kernelVersion",
        "ua", "hardwareConcurrency", "deviceMemory", "screenW", "screenH",
        "devicePixelRatio", "gpuVendor", "gpuRenderer", "languages", "timezone",
    }
    assert Persona.from_dict(json.loads(json.dumps(data))) == persona


def test_persona_is_frozen_after_first_use(tmp_path):
    first = load_or_generate_persona(tmp_path, "150.0.0.0")
    for _ in range(5):
        assert load_or_generate_persona(tmp_path, "149.0.0.0") == first
    assert (tmp_path / "persona.json").exists()


def test_existing_profile_keeps_its_own_kernel_version(tmp_path):
    load_or_generate_persona(tmp_path, "149.0.0.0")
    later = load_or_generate_persona(tmp_path, "150.0.0.0")
    assert later.kernel_version == "149"
    assert later.chrome_major == 149


def test_missing_kernel_version_is_backfilled(tmp_path):
    persona = generate_persona(149, "149.0.0.0")
    data = persona.to_dict()
    del data["kernelVersion"]
    (tmp_path / "persona.json").write_text(json.dumps(data), encoding="utf-8")

    loaded = load_or_generate_persona(tmp_path, "150.0.0.0")
    assert loaded.kernel_version == "150"
    on_disk = json.loads((tmp_path / "persona.json").read_text(encoding="utf-8"))
    assert on_disk["kernelVersion"] == "150"
    assert on_disk["seed"] == persona.seed  # the identity itself is untouched


def test_corrupted_persona_is_regenerated_instead_of_raising(tmp_path):
    (tmp_path / "persona.json").write_text("{not json", encoding="utf-8")
    persona = load_or_generate_persona(tmp_path, "150.0.0.0")
    assert HEX16.match(persona.seed)
    assert load_or_generate_persona(tmp_path, "150.0.0.0") == persona


#: A persona.json written by the Node SDK (anti-detect-browser 1.5.0) and read
#: back verbatim, so the two runtimes can share one profile directory.
NODE_SDK_PERSONA = """{
  "seed": "d3a92d0174657118",
  "canvasSeed": "a8b43f4fd23c9af0",
  "audioSeed": "9feaa12d9c49989a",
  "domrectSeed": "7b707bdcb10e42c7",
  "chromeMajor": 150,
  "kernelVersion": "150.0.0.0",
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  "hardwareConcurrency": 16,
  "deviceMemory": 16,
  "screenW": 1707,
  "screenH": 960,
  "devicePixelRatio": 1.5,
  "gpuVendor": "Google Inc. (AMD)",
  "gpuRenderer": "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)",
  "languages": ["en-US", "en"],
  "timezone": "America/Los_Angeles"
}"""


def test_a_profile_written_by_the_node_sdk_loads_unchanged(tmp_path):
    (tmp_path / "persona.json").write_text(NODE_SDK_PERSONA, encoding="utf-8")
    persona = load_or_generate_persona(tmp_path, "149.0.0.0")

    assert persona.seed == "d3a92d0174657118"
    assert persona.kernel_version == "150"
    assert persona.chrome_major == 150
    assert persona.device_pixel_ratio == 1.5
    assert persona.languages == ["en-US", "en"]
    # Nothing was rewritten: the identity is still byte-identical on disk.
    assert json.loads((tmp_path / "persona.json").read_text(encoding="utf-8")) == json.loads(
        NODE_SDK_PERSONA
    )


def test_write_persona_creates_missing_directories(tmp_path):
    target = tmp_path / "deep" / "profile"
    persona = generate_persona(150, "150.0.0.0")
    path = write_persona(target, persona)
    assert path.exists()
    assert json.loads(path.read_text(encoding="utf-8"))["seed"] == persona.seed


@pytest.mark.parametrize("bad", ["", "abc", "x.1.2"])
def test_chrome_major_rejects_malformed_versions(bad):
    with pytest.raises(ValueError):
        chrome_major_of(bad)
