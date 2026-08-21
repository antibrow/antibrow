"""Port of oss/js/tests/engine/persona-font-alias.test.ts - keep the two in sync.

A Windows persona on a Windows host needs no aliases; on any other host the
Windows-only families are missing, and a missing family measures exactly like
one that was never installed - the single signal that told a signup flow the
persona was lying. The stand-ins must never join ``allow``: a real Windows
machine has no Selawik to enumerate.
"""

from __future__ import annotations

from antibrow.persona import generate_persona, persona_to_fp_config

_EXPECTED_ALIAS = {
    "segoe ui": "Selawia",
    "segoe ui semibold": "Selawia",
    "segoe ui symbol": "Selawia",
    "calibri": "Carlina",
    "cambria": "Caladria",
    "cambria math": "Caladria",
    "consolas": "Consolita",
    "sylfaen": "Sylfano",
    "franklin gothic medium": "Franklito",
    "ebrima": "Ebrisa",
    "times new roman": "Liberation Serif",
    "arial": "Liberation Sans",
    "courier new": "Courina",
    "georgia": "Georgina",
}


def _fonts_for(host_platform, device_type=None):
    persona = generate_persona(150, "150", device_type=device_type)
    config = persona_to_fp_config(
        persona, label="x", timezone="UTC", host_platform=host_platform
    )
    return config["fonts"]


def test_stand_ins_ship_on_a_non_windows_host():
    for host in ("darwin", "linux"):
        assert _fonts_for(host)["alias"] == _EXPECTED_ALIAS


def test_no_alias_on_a_windows_host_where_those_families_are_real():
    assert "alias" not in _fonts_for("win32")


def test_keys_are_lowercase_and_trimmed_as_the_kernel_looks_them_up():
    for key in _fonts_for("darwin")["alias"]:
        assert key == key.strip().lower()


def test_no_stand_in_ever_enters_the_enumerable_set():
    fonts = _fonts_for("darwin")
    allow = [f.lower() for f in fonts["allow"]]
    for substitute in fonts["alias"].values():
        assert substitute.lower() not in allow


def test_covers_the_windows_only_families_the_allowlist_offers():
    # An alias only bites for a family ``allow`` lets through, so these two
    # lists have to stay in step. The extra 'segoe ui semibold' entry is inert
    # until the allowlist names that weight, which is why it is not asserted.
    fonts = _fonts_for("darwin")
    allow = [f.lower() for f in fonts["allow"]]
    for family in (
        "segoe ui", "segoe ui symbol", "calibri", "cambria", "cambria math",
        "times new roman", "arial", "courier new",
        "consolas", "sylfaen", "franklin gothic medium", "ebrima", "georgia",
    ):
        assert family in allow
        assert fonts["alias"][family]


def test_android_persona_is_left_alone_its_families_ship_with_the_kernel():
    assert "alias" not in _fonts_for("darwin", device_type="android")
