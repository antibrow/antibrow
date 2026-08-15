"""Moving an existing profile to another kernel major without re-rolling it."""

import json

import pytest

from antibrow import kernel as K
from antibrow.browser import set_profile_kernel_version, should_restore_archive
from antibrow.errors import KernelDownloadError
from antibrow.persona import generate_persona, read_persona, write_persona
from antibrow.profile_cache import pack_profile_cache, unpack_profile_cache
from antibrow.profile_dir import resolve_profile_dir

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


def test_rewrites_the_three_version_derived_fields_and_nothing_else(tmp_path, profile_dir):
    before = read_persona(profile_dir)

    after = set_profile_kernel_version(NEW, profile_dir=profile_dir, cache_dir=tmp_path)

    assert after.kernel_version == NEW
    assert after.chrome_major == 151
    assert "Chrome/151.0.0.0" in after.ua
    # The identity itself must survive: re-rolling seeds/GPU/screen on a profile
    # that already carries live cookies is a change sites can see.
    changed = {"kernelVersion", "chromeMajor", "ua"}
    assert {k: v for k, v in after.to_dict().items() if k not in changed} == {
        k: v for k, v in before.to_dict().items() if k not in changed
    }


def test_persists_the_rewrite(tmp_path, profile_dir):
    set_profile_kernel_version(NEW, profile_dir=profile_dir, cache_dir=tmp_path)

    on_disk = read_persona(profile_dir)
    assert on_disk.kernel_version == NEW
    assert on_disk.chrome_major == 151


def test_accepts_a_legacy_full_version_string(tmp_path, profile_dir):
    after = set_profile_kernel_version(NEW + ".0.0.1", profile_dir=profile_dir, cache_dir=tmp_path)
    assert after.kernel_version == NEW


def test_finds_the_profile_by_name(tmp_path):
    resolved = resolve_profile_dir("gmail-1", tmp_path)
    write_persona(resolved.dir, generate_persona(int(OLD), OLD))

    after = set_profile_kernel_version(NEW, profile_name="gmail-1", cache_dir=tmp_path)

    assert after.kernel_version == NEW
    assert read_persona(resolved.dir).kernel_version == NEW


def test_refuses_a_version_the_catalogue_does_not_know(tmp_path, profile_dir):
    with pytest.raises(KernelDownloadError, match="not in the catalogue"):
        set_profile_kernel_version("900", profile_dir=profile_dir, cache_dir=tmp_path)
    assert read_persona(profile_dir).kernel_version == OLD


def test_refuses_a_kernel_without_the_mobile_patches_for_android(tmp_path):
    directory = tmp_path / "android"
    persona = generate_persona(151, NEW)
    persona.device_type = "android"
    persona.android_model = "Pixel 8"
    persona.ua = (
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36"
    )
    write_persona(directory, persona)

    with pytest.raises(RuntimeError, match="Android profiles need kernel"):
        set_profile_kernel_version(OLD, profile_dir=directory, cache_dir=tmp_path)
    assert read_persona(directory).kernel_version == NEW


def test_rewrites_the_chrome_major_inside_an_android_ua(tmp_path):
    directory = tmp_path / "android"
    persona = generate_persona(int(OLD), OLD)
    persona.device_type = "android"
    persona.android_model = "Pixel 8"
    persona.ua = (
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/{0}.0.0.0 Mobile Safari/537.36".format(OLD)
    )
    write_persona(directory, persona)

    after = set_profile_kernel_version(NEW, profile_dir=directory, cache_dir=tmp_path)

    assert after.ua == (
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36"
    )
    assert after.android_model == "Pixel 8"


def test_refuses_a_profile_that_has_no_persona_yet(tmp_path):
    with pytest.raises(FileNotFoundError, match="has no persona"):
        set_profile_kernel_version(NEW, profile_dir=tmp_path / "empty", cache_dir=tmp_path)


# persona.json rides the cloud archive, and the restore runs before the persona
# is read - so whether a switch survives is entirely decided by the generation
# marker. These pin both sides of that.
def test_switch_survives_on_the_machine_holding_the_current_generation():
    assert should_restore_archive("etag-1", "etag-1") is False


def test_switch_is_restored_over_for_a_different_or_unnameable_generation():
    assert should_restore_archive(None, "etag-1") is True
    assert should_restore_archive("etag-1", "etag-2") is True
    # An older server, or an R2 object that does not exist yet: nothing to
    # compare, so the restore is unconditional.
    assert should_restore_archive("etag-1", None) is True


def test_a_restore_that_does_run_loses_the_switch(tmp_path, profile_dir):
    cloud = pack_profile_cache(profile_dir)  # packed while still on the old kernel

    # The switch happens after that upload...
    set_profile_kernel_version(NEW, profile_dir=profile_dir, cache_dir=tmp_path)
    # ...and a restore puts the old identity back, kernel version included.
    unpack_profile_cache(cloud, profile_dir)

    assert read_persona(profile_dir).kernel_version == OLD
