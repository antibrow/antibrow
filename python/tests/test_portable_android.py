"""``.fpprofile`` handling for Android and captured-machine profiles.

Mirrors ``oss/js/tests/engine/portable-android.test.ts`` and its gate sibling.
The kernel catalogue is module-global and pytest runs every file in one process,
so each test here sets the registry to exactly the state it means to test and
restores it afterwards rather than inheriting whatever ran before it.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from antibrow import kernel as K
from antibrow import portable as P
from antibrow.errors import ProfileCacheError
from antibrow.persona import CapturedFacts, generate_persona, write_persona

ANDROID_ASSET = K.KernelVersion(
    version=K.ANDROID_MIN_KERNEL_VERSION,
    label="Chrome 151",
    platforms={
        K.current_platform(): K.KernelAsset(
            download_url="https://example.test/k.zip",
            exe_rel_path="chrome",
            build="2026-08-07 05:17",
        )
    },
)


@pytest.fixture()
def catalogue():
    """Hand the test an empty registry, and put the old one back afterwards."""
    saved = list(K._registered)
    K._registered.clear()
    yield K._registered
    K._registered[:] = saved


def _android_persona():
    return generate_persona(151, K.ANDROID_MIN_KERNEL_VERSION, device_type="android")


def _profile_with(root, persona):
    root.mkdir(parents=True, exist_ok=True)
    write_persona(root, persona)
    return root


def test_export_refuses_a_profile_whose_identity_is_not_resolved_yet(tmp_path):
    # The desktop app deliberately defers persona.json for android and
    # captured-machine profiles. Generating one here would freeze a plain
    # desktop identity onto it, permanently.
    root = tmp_path / "empty"
    root.mkdir()
    with pytest.raises(ProfileCacheError, match="no identity yet"):
        P.export_profile_archive(root, P.PortableProfileMeta(name="a", device_type="android"))
    assert not (root / "persona.json").exists()


def test_export_refuses_a_row_that_disagrees_with_its_persona(tmp_path):
    root = _profile_with(tmp_path / "a", _android_persona())
    with pytest.raises(ProfileCacheError, match="mismatch"):
        P.export_profile_archive(root, P.PortableProfileMeta(name="a", device_type="desktop"))


def test_import_carries_the_device_type_and_library_flag_back(tmp_path, catalogue):
    K.register_kernel_versions([ANDROID_ASSET])
    root = _profile_with(tmp_path / "a", _android_persona())
    data = P.export_profile_archive(
        root,
        P.PortableProfileMeta(
            name="a", kernel_version=K.ANDROID_MIN_KERNEL_VERSION, real_fingerprint=True
        ),
    )

    meta = P.import_profile_archive(data, tmp_path / "restored")

    assert meta.device_type == "android"
    assert meta.real_fingerprint is True
    assert meta.kernel_version == K.ANDROID_MIN_KERNEL_VERSION


def test_ua_mobile_false_survives_the_round_trip(tmp_path):
    # Every bundled android row is mobile: True, so the presence guard on this
    # field was never exercised - and the paid desktop path (os=windows) sends
    # exactly mobile: False.
    persona = generate_persona(150, K.default_kernel_version().version)
    persona.device_type = "desktop"
    persona.captured = CapturedFacts(
        ua_mobile=False, ua_architecture="", ua_bitness="", platform="Win32"
    )
    root = _profile_with(tmp_path / "w", persona)

    data = P.export_profile_archive(root, P.PortableProfileMeta(name="w"))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    assert manifest["profile"]["persona"]["captured"]["ua_mobile"] is False

    P.import_profile_archive(data, tmp_path / "restored")
    restored = json.loads((tmp_path / "restored" / "persona.json").read_text())
    assert restored["captured"]["uaMobile"] is False


def test_import_refuses_an_android_pin_the_catalogue_does_not_know(tmp_path, catalogue):
    # A fresh process has no Android kernel registered: the lenient resolver
    # would rewrite the pin to the default Chrome major and hand back a profile
    # that claims to be a phone and cannot behave like one.
    K.register_kernel_versions([ANDROID_ASSET])
    root = _profile_with(tmp_path / "a", _android_persona())
    data = P.export_profile_archive(
        root, P.PortableProfileMeta(name="a", kernel_version=K.ANDROID_MIN_KERNEL_VERSION)
    )
    K._registered.clear()

    assert K.ANDROID_MIN_KERNEL_VERSION != K.default_kernel_version().version
    dest = tmp_path / "restored"
    with pytest.raises(ProfileCacheError, match="not in the catalogue"):
        P.import_profile_archive(data, dest)
    # Nothing written: a refused import must not leave a half-restored directory.
    assert not dest.exists() or list(dest.iterdir()) == []
