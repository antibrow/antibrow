"""The cloud archive generation marker: what this machine last restored/uploaded.

Mirrors ``oss/js/tests/engine/archive-version.test.ts`` line for line: marker
roundtrip, ETag unquoting, exclusion from a packed archive, and clearing on
portable import.
"""

from test_profile_cache import entries, make_profile

from antibrow import profile_cache as P
from antibrow.persona import generate_persona, write_persona
from antibrow.portable import PortableProfileMeta, export_profile_archive, import_profile_archive


def test_marker_roundtrips_and_reports_absence_as_none(tmp_path):
    assert P.read_archive_version(tmp_path) is None

    P.write_archive_version(tmp_path, "abc123")
    assert P.read_archive_version(tmp_path) == "abc123"

    P.clear_archive_version(tmp_path)
    assert P.read_archive_version(tmp_path) is None


def test_clear_tolerates_a_missing_marker(tmp_path):
    P.clear_archive_version(tmp_path)  # no marker written yet - must not raise


def test_read_tolerates_a_marker_with_invalid_utf8(tmp_path):
    # The JS SDK's readFileSync degrades invalid UTF-8 to replacement
    # characters (a marker mismatch, so it just re-downloads); a corrupt local
    # file must be equally non-fatal here rather than raising UnicodeDecodeError
    # and failing the whole launch.
    marker = tmp_path / P.ARCHIVE_VERSION_FILE
    marker.write_bytes(b"\xff\xfe\x00abc")

    assert P.read_archive_version(tmp_path) is None


def test_normalize_strips_the_quotes_r2_wraps_an_etag_in():
    assert P.normalize_archive_version('"abc123"') == "abc123"
    assert P.normalize_archive_version(None) is None
    assert P.normalize_archive_version("") is None
    assert P.normalize_archive_version('""') is None


def test_marker_is_never_packed_into_a_cloud_archive(tmp_path):
    root = make_profile(tmp_path)
    P.write_archive_version(root, "abc123")

    names = entries(P.pack_profile_cache(root))

    assert "user-data/Default/Cookies" in names
    assert P.ARCHIVE_VERSION_FILE not in names


def test_marker_is_dropped_when_a_portable_archive_is_imported(tmp_path):
    src = make_profile(tmp_path / "src")
    # Export no longer creates an identity, so this profile has to have one.
    write_persona(src, generate_persona(150, "150.0.7871.182"))
    data = export_profile_archive(src, PortableProfileMeta(name="Exported"))
    dest = tmp_path / "dest"
    P.write_archive_version(dest, "stale")

    import_profile_archive(data, dest)

    assert P.read_archive_version(dest) is None


def test_marker_is_dropped_when_a_legacy_zip_is_imported(tmp_path):
    import io
    import json
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("profile.json", json.dumps({"name": "Imported"}))
        zf.writestr("user-data/Local State", "ls")
    dest = tmp_path
    P.write_archive_version(dest, "stale")

    import_profile_archive(buf.getvalue(), dest)

    assert P.read_archive_version(dest) is None
