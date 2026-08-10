"""``.fpprofile`` export/import - the interchange format, not the cloud cache.

The manifest shape is a contract with other readers of the same format, so it is
asserted key by key rather than only round-tripped.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from antibrow import kernel as K
from antibrow import portable as P
from antibrow.errors import ProfileCacheError
from antibrow.persona import generate_persona, write_persona


def make_profile(root, persona=None):
    root.mkdir(parents=True, exist_ok=True)
    write_persona(root, persona or generate_persona(150, K.default_kernel_version().version))
    (root / "passkeys.json").write_text(json.dumps([{"rp": "webauthn.io"}]))
    default = root / "user-data" / "Default"
    default.mkdir(parents=True)
    (default / "Cookies").write_text("cookie-db")
    (default / "Cookies-wal").write_text("write-ahead")
    (default / "Preferences").write_text("{}")
    (default / "Top Sites").write_text("not portable")
    (default / "Cache").mkdir()
    (default / "Cache" / "data_0").write_text("disposable")
    (root / "user-data" / "Local State").write_text("{}")
    return root


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return set(zf.namelist())


def manifest_of(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return json.loads(zf.read("manifest.json"))


# -- export ---------------------------------------------------------------


def test_export_writes_the_interchange_manifest(tmp_path):
    profile = make_profile(tmp_path / "p1")

    manifest = manifest_of(
        P.export_profile_archive(
            profile,
            P.PortableProfileMeta(name="shopper-01", proxy_url="http://u:p@gate:8080"),
        )
    )

    assert manifest["format"] == "fp-launcher-profile"
    assert manifest["version"] == 1
    entry = manifest["profile"]
    assert entry["name"] == "shopper-01"
    assert entry["id"] == "p1"
    assert entry["proxy"] == {"raw": "http://u:p@gate:8080"}
    assert entry["kernel_version"] == K.default_kernel_version().version
    assert entry["api_log"] == "off"
    assert entry["canvas_noise"] is True
    assert entry["webauthn_capture"] is True
    # The persona travels snake_cased, which is what other readers expect.
    persona = json.loads((profile / "persona.json").read_text())
    assert entry["persona"]["seed"] == persona["seed"]
    assert entry["persona"]["canvas_seed"] == persona["canvasSeed"]
    assert entry["persona"]["screen_w"] == persona["screenW"]
    assert entry["persona"]["gpu_renderer"] == persona["gpuRenderer"]


def test_export_carries_the_passkey_store_and_portable_state_only(tmp_path):
    names = entries(
        P.export_profile_archive(make_profile(tmp_path / "p1"), P.PortableProfileMeta(name="p1"))
    )

    assert "passkeys.json" in names
    assert "user-data/Default/Cookies" in names
    assert "user-data/Default/Cookies-wal" in names  # SQLite sibling
    assert "user-data/Default/Preferences" in names
    assert "user-data/Local State" in names
    assert "user-data/Default/Top Sites" not in names  # not on the whitelist
    assert not any(name.startswith("user-data/Default/Cache/") for name in names)
    assert "persona.json" not in names  # identity lives in the manifest


def test_app_specific_extras_ride_in_their_own_section(tmp_path):
    manifest = manifest_of(
        P.export_profile_archive(
            make_profile(tmp_path / "p1"),
            P.PortableProfileMeta(name="p1", extra={"group": "ads", "color": "#C6E76B"}),
        )
    )

    assert manifest["antibrow"] == {"group": "ads", "color": "#C6E76B"}
    assert "antibrow" not in manifest["profile"]


def test_behaviour_switches_are_recorded_as_given(tmp_path):
    manifest = manifest_of(
        P.export_profile_archive(
            make_profile(tmp_path / "p1"),
            P.PortableProfileMeta(
                name="p1", api_log="curated", canvas_noise=False, webauthn_capture=False
            ),
        )
    )

    assert manifest["profile"]["api_log"] == "curated"
    assert manifest["profile"]["canvas_noise"] is False
    assert manifest["profile"]["webauthn_capture"] is False


# -- import ---------------------------------------------------------------


def test_a_round_trip_keeps_the_identity_the_state_and_the_passkeys(tmp_path):
    source = make_profile(tmp_path / "p1")
    original = json.loads((source / "persona.json").read_text())
    data = P.export_profile_archive(
        source, P.PortableProfileMeta(name="shopper-01", proxy_url="socks5://gate:1080")
    )
    dest = tmp_path / "restored"

    meta = P.import_profile_archive(data, dest)

    assert json.loads((dest / "persona.json").read_text())["seed"] == original["seed"]
    assert (dest / "passkeys.json").read_text() == json.dumps([{"rp": "webauthn.io"}])
    assert (dest / "user-data" / "Default" / "Cookies").read_text() == "cookie-db"
    assert not (dest / "manifest.json").exists()  # metadata never lands on disk
    assert meta.source == "launcher"
    assert meta.name == "shopper-01"
    assert meta.proxy_url == "socks5://gate:1080"
    assert meta.kernel_version == K.default_kernel_version().version


def test_a_captured_webgl_report_survives_the_round_trip(tmp_path):
    persona = generate_persona(150, K.default_kernel_version().version)
    persona.captured_webgl = {"VERSION": "WebGL 1.0", "params": {"MAX_TEXTURE_SIZE": 16384}}
    source = make_profile(tmp_path / "p1", persona)
    data = P.export_profile_archive(source, P.PortableProfileMeta(name="p1"))

    P.import_profile_archive(data, tmp_path / "restored")

    restored = json.loads((tmp_path / "restored" / "persona.json").read_text())
    assert restored["capturedWebgl"] == {"VERSION": "WebGL 1.0", "params": {"MAX_TEXTURE_SIZE": 16384}}


def test_an_unavailable_kernel_falls_back_and_drags_the_ua_along(tmp_path):
    # A profile exported against a build this install has never heard of must
    # still launch, and its UA major has to match whatever kernel it gets.
    source = make_profile(tmp_path / "p1")
    data = P.export_profile_archive(
        source, P.PortableProfileMeta(name="p1", kernel_version="77.0.1.1")
    )

    meta = P.import_profile_archive(data, tmp_path / "restored")

    fallback = K.default_kernel_version().version
    major = int(fallback.split(".")[0])
    assert meta.kernel_version == fallback
    persona = json.loads((tmp_path / "restored" / "persona.json").read_text())
    assert persona["kernelVersion"] == fallback
    assert persona["chromeMajor"] == major
    assert "Chrome/{0}.0.0.0".format(major) in persona["ua"]


def test_the_same_chrome_major_is_preferred_over_the_default(tmp_path, monkeypatch):
    known = K.KernelVersion(
        "149.0.7827.201",
        "Chrome 149",
        {K.current_platform(): K.KernelAsset("https://download.antibrow.com/x.zip", "chrome")},
    )
    monkeypatch.setattr(K, "_registered", [known])
    data = P.export_profile_archive(
        make_profile(tmp_path / "p1"), P.PortableProfileMeta(name="p1", kernel_version="149.0.1.1")
    )

    meta = P.import_profile_archive(data, tmp_path / "restored")

    assert meta.kernel_version == "149.0.7827.201"


def test_an_unknown_format_is_refused(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"format": "something-else", "version": 1}))

    with pytest.raises(ProfileCacheError, match="format"):
        P.import_profile_archive(buf.getvalue(), tmp_path / "restored")


def test_an_archive_from_a_newer_release_is_refused_with_advice(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        # 99, not 2: an Android archive legitimately carries version 2 now
        # (P.FORMAT_VERSION), so the probe needs a value beyond what any
        # release actually writes - matches the JS SDK's own test, which
        # made the same change (2 -> 99) when it bumped its format version.
        zf.writestr("manifest.json", json.dumps({"format": "fp-launcher-profile", "version": 99}))

    with pytest.raises(ProfileCacheError, match="newer"):
        P.import_profile_archive(buf.getvalue(), tmp_path / "restored")


def test_a_corrupt_manifest_is_refused(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", "{not json")

    with pytest.raises(ProfileCacheError, match="manifest.json"):
        P.import_profile_archive(buf.getvalue(), tmp_path / "restored")


def test_the_legacy_zip_export_still_imports(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "profile.json",
            json.dumps({"name": "old-one", "kernelVersion": "150.0.7871.182", "group": "ads"}),
        )
        zf.writestr("user-data/Default/Cookies", "cookie-db")
    dest = tmp_path / "restored"

    meta = P.import_profile_archive(buf.getvalue(), dest)

    assert meta.source == "legacy"
    assert meta.name == "old-one"
    assert meta.kernel_version == "150.0.7871.182"
    assert meta.extra == {"group": "ads"}
    assert (dest / "user-data" / "Default" / "Cookies").exists()
    assert not (dest / "profile.json").exists()


def test_entries_pointing_outside_the_profile_are_ignored(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps({"format": "fp-launcher-profile", "version": 1, "profile": {"name": "p"}}),
        )
        zf.writestr("../escaped.json", "nope")
        zf.writestr("passkeys.json", "[]")
    dest = tmp_path / "restored"

    P.import_profile_archive(buf.getvalue(), dest)

    assert (dest / "passkeys.json").exists()
    assert not (tmp_path / "escaped.json").exists()
