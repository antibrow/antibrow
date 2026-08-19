"""Moving an existing profile to another kernel major without re-rolling it."""

import json
from pathlib import Path

import pytest

from antibrow import browser as B
from antibrow import kernel as K
from antibrow.browser import ArchiveCommit, set_profile_kernel_version, should_restore_archive
from antibrow.errors import KernelDownloadError
from antibrow.persona import generate_persona, read_persona, write_persona
from antibrow.profile_cache import (
    pack_profile_cache,
    read_archive_version,
    unpack_profile_cache,
    write_archive_version,
)
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


def test_the_archive_itself_carries_the_switch_once_committed(tmp_path, profile_dir, monkeypatch):
    """What makes a switch hold across cache directories and machines.

    They all restore from the archive, and the archive now names the new kernel -
    nothing machine-local has to remember the switch.
    """
    uploaded = {}

    def fake_upload(directory, put_url):
        uploaded["archive"] = pack_profile_cache(directory)
        return "gen-2"

    monkeypatch.setattr(B, "upload_profile_cache", fake_upload)
    write_archive_version(profile_dir, "gen-1")

    set_profile_kernel_version(
        NEW,
        profile_dir=profile_dir,
        cache_dir=tmp_path,
        archive=ArchiveCommit(version="gen-1", get_put_url=lambda: "https://r2/put"),
    )

    elsewhere = tmp_path / "other"
    unpack_profile_cache(uploaded["archive"], elsewhere)
    assert read_persona(elsewhere).kernel_version == NEW
    assert read_archive_version(profile_dir) == "gen-2"


def test_starts_from_the_cloud_copy_when_this_directory_is_behind(tmp_path, profile_dir, monkeypatch):
    # Another machine may hold a newer archive; moving the local copy and
    # uploading it would silently discard whatever that machine saved.
    cloud_dir = tmp_path / "cloud"
    (cloud_dir / "user-data" / "Default").mkdir(parents=True)
    (cloud_dir / "user-data" / "Default" / "Cookies").write_text("from-the-cloud", encoding="utf-8")
    write_persona(cloud_dir, generate_persona(int(OLD), OLD))
    cloud = pack_profile_cache(cloud_dir)

    monkeypatch.setattr(
        B, "download_profile_cache", lambda url, directory: (unpack_profile_cache(cloud, directory), True)[1]
    )
    uploaded = {}
    monkeypatch.setattr(
        B, "upload_profile_cache", lambda directory, url: uploaded.setdefault("d", Path(directory)) and "gen-2"
    )
    write_archive_version(profile_dir, "gen-0")

    set_profile_kernel_version(
        NEW,
        profile_dir=profile_dir,
        cache_dir=tmp_path,
        archive=ArchiveCommit(
            get_url="https://r2/get", version="gen-1", get_put_url=lambda: "https://r2/put"
        ),
    )

    assert (profile_dir / "user-data" / "Default" / "Cookies").read_text(encoding="utf-8") == "from-the-cloud"


def test_rolls_the_persona_back_when_the_upload_fails(tmp_path, profile_dir, monkeypatch):
    before = read_persona(profile_dir)

    def boom(directory, put_url):
        raise RuntimeError("Failed to upload profile cache: HTTP 500")

    monkeypatch.setattr(B, "upload_profile_cache", boom)

    with pytest.raises(RuntimeError, match="upload"):
        set_profile_kernel_version(
            NEW,
            profile_dir=profile_dir,
            cache_dir=tmp_path,
            archive=ArchiveCommit(get_put_url=lambda: "https://r2/put"),
        )

    # Half a switch is the drift this whole change removes.
    assert read_persona(profile_dir).kernel_version == before.kernel_version


def test_an_uncommitted_switch_is_replaced_by_a_restore(tmp_path, profile_dir):
    # Not a regression - the reason `archive` exists. An uncommitted switch is
    # one machine's opinion, and the cloud copy is what everyone else reads.
    cloud = pack_profile_cache(profile_dir)

    set_profile_kernel_version(NEW, profile_dir=profile_dir, cache_dir=tmp_path)
    unpack_profile_cache(cloud, profile_dir)

    assert read_persona(profile_dir).kernel_version == OLD
