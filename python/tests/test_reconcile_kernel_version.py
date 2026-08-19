"""The caller's stored kernel version must not be silently dropped.

A launch is handed the caller's idea of the kernel (a launcher or the desktop
app passes its stored row on every launch) and the persona on disk. They drift
apart whenever the stored one moves on its own - cloud sync copies that field
between machines and never touches the profile directory - and the drift used to
be silent: the row read 152, the browser launched 150 and introduced itself as
Chrome 150 to every site.
"""

from __future__ import annotations

import json

import pytest

from antibrow import kernel as K
from antibrow.browser import reconcile_kernel_version
from antibrow.persona import generate_persona, read_persona, write_persona

NEW = "151"
OLD = K.default_kernel_version().version

MANIFEST = json.dumps(
    {
        "versions": [
            {
                "version": NEW + ".0.0.1",
                "label": "Chrome " + NEW,
                "platform": platform,
                "download_url": "fp-chromium-{0}-{1}.zip".format(NEW, platform),
                "build": "2026-08-11 10:00",
            }
            for platform in ("win64", "linux64", "linuxarm64", "mac-universal")
        ]
    }
)


@pytest.fixture(autouse=True)
def catalogue(monkeypatch):
    """A manifest-only 151, kept out of the other test modules."""
    monkeypatch.setattr(K, "_registered", [])
    monkeypatch.setattr(
        K,
        "fetch_remote_kernel_versions",
        lambda manifest_url=K.KERNEL_MANIFEST_URL: K.parse_kernel_manifest(MANIFEST, manifest_url),
    )


@pytest.fixture
def profile_dir(tmp_path):
    directory = tmp_path / "profile"
    write_persona(directory, generate_persona(int(OLD), OLD))
    return directory


def _seed(directory):
    return read_persona(directory)


def test_moves_the_persona_onto_the_requested_version_and_pins_it(profile_dir, tmp_path):
    before = _seed(profile_dir)
    messages = []

    after = reconcile_kernel_version(
        profile_dir, before, NEW, cache_dir=tmp_path, on_progress=messages.append
    )

    assert after.kernel_version == NEW
    assert read_persona(profile_dir).kernel_version == NEW
    assert after.seed == before.seed
    assert OLD in "\n".join(messages) and NEW in "\n".join(messages)


def test_accepts_a_full_four_segment_version_as_the_same_major(profile_dir, tmp_path):
    before = _seed(profile_dir)
    after = reconcile_kernel_version(
        profile_dir, before, "{0}.0.7871.182".format(OLD), cache_dir=tmp_path
    )
    assert after is before


def test_treats_a_legacy_four_segment_persona_as_its_major(profile_dir, tmp_path):
    # Profiles created before the majors-only change still carry the full string
    # on disk, and it is never rewritten just for being read. Comparing raw
    # strings would call that a mismatch and rewrite + pin for nothing.
    raw = json.loads((profile_dir / "persona.json").read_text(encoding="utf-8"))
    raw["kernelVersion"] = "{0}.0.7871.182".format(OLD)
    (profile_dir / "persona.json").write_text(json.dumps(raw), encoding="utf-8")
    on_disk = read_persona(profile_dir)

    after = reconcile_kernel_version(profile_dir, on_disk, OLD, cache_dir=tmp_path)

    assert after is on_disk


def test_still_moves_a_legacy_four_segment_persona_to_another_major(profile_dir, tmp_path):
    raw = json.loads((profile_dir / "persona.json").read_text(encoding="utf-8"))
    raw["kernelVersion"] = "{0}.0.7871.182".format(OLD)
    (profile_dir / "persona.json").write_text(json.dumps(raw), encoding="utf-8")
    on_disk = read_persona(profile_dir)

    after = reconcile_kernel_version(profile_dir, on_disk, NEW, cache_dir=tmp_path)

    assert after.kernel_version == NEW


def test_leaves_the_profile_alone_when_the_caller_named_nothing(profile_dir, tmp_path):
    before = _seed(profile_dir)
    assert reconcile_kernel_version(profile_dir, before, None, cache_dir=tmp_path) is before


def test_reports_an_unknown_version_instead_of_failing_the_launch(profile_dir, tmp_path):
    before = _seed(profile_dir)
    messages = []

    after = reconcile_kernel_version(
        profile_dir, before, "900", cache_dir=tmp_path, on_progress=messages.append
    )

    assert after.kernel_version == OLD
    assert "catalogue" in "\n".join(messages)
