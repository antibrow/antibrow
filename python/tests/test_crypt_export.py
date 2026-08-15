"""Exporting an encrypted profile packs a converted COPY.

The recipient holds no key, so an archive of the directory as it stands is a file
nobody can open. Mirrors ``oss/js/tests/engine/crypt-export.test.ts`` and
``crypt-export-kernel.test.ts``.
"""

import importlib
import io
import json
import zipfile

import pytest

from antibrow import kernel as K
from antibrow import portable as PT
from antibrow.errors import ProfileCacheError
from antibrow.persona import generate_persona, write_persona
from antibrow.portable import PortableProfileMeta, export_profile_archive

D = importlib.import_module("antibrow.profile_dir")

KEY = "a1" * 32
VERSION = K.default_kernel_version().version
META = PortableProfileMeta(name="shop-01", id="p-1", kernel_version=VERSION)


def seed(directory, *, encrypted):
    (directory / "user-data" / "Default").mkdir(parents=True)
    write_persona(directory, generate_persona(151, VERSION))
    (directory / "user-data" / "Local State").write_text(
        json.dumps({"fp_crypt": {"key_check": "KC"}, "variations_seed": "v"} if encrypted else {"variations_seed": "v"})
    )
    (directory / "user-data" / "Default" / "Cookies").write_bytes(
        b"SQLite format 3\x00" + (b"fp2SECRET" if encrypted else b"fp1SECRET")
    )
    if encrypted:
        D.mark_profile_encrypted(directory)
    return directory


def convert(user_data_dir):
    """What the kernel does: drop the fp_crypt block, re-tag ciphertext fp2 -> fp1."""
    local_state = user_data_dir / "Local State"
    parsed = json.loads(local_state.read_text())
    parsed.pop("fp_crypt", None)
    local_state.write_text(json.dumps(parsed))
    cookies = user_data_dir / "Default" / "Cookies"
    cookies.write_bytes(cookies.read_bytes().replace(b"fp2", b"fp1"))


def entry(data, name):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read(name)


def names(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return sorted(zf.namelist())


class TestExportingAnEncryptedProfile:
    def test_packs_data_that_opens_with_no_key_and_leaves_the_original_encrypted(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)
        staging = tmp_path / "staging"
        staging.mkdir()
        seen = []

        def rekey(user_data_dir, from_key, to_key):
            seen.append((user_data_dir, from_key, to_key))
            convert(user_data_dir)

        data = export_profile_archive(src, META, crypt_key=KEY, tmp_dir=staging, rekey=rekey)

        assert "fp_crypt" not in json.loads(entry(data, "user-data/Local State"))
        cookies = entry(data, "user-data/Default/Cookies")
        assert b"fp1SECRET" in cookies and b"fp2" not in cookies
        # The source directory is not the thing being converted.
        assert not str(seen[0][0]).startswith(str(src))
        assert (seen[0][1], seen[0][2]) == (KEY, "none")
        # Original untouched: still key-bound, still launchable with its key.
        assert json.loads((src / "user-data" / "Local State").read_text())["fp_crypt"] == {"key_check": "KC"}
        assert b"fp2SECRET" in (src / "user-data" / "Default" / "Cookies").read_bytes()
        assert D.is_profile_encrypted(src) is True

    # The manifest id falls back to the directory name, and the copy is not named
    # after the profile.
    def test_keeps_the_profile_id_even_though_the_pack_runs_on_a_copy(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)

        data = export_profile_archive(
            src,
            PortableProfileMeta(name="shop-01"),
            crypt_key=KEY,
            tmp_dir=tmp_path,
            rekey=lambda ud, f, t: convert(ud),
        )

        assert json.loads(entry(data, "manifest.json"))["profile"]["id"] == src.name

    # The regression that matters: the kernel ignores switches it does not know,
    # so a build without the rekey feature starts, converts nothing and exits 0.
    def test_aborts_when_the_conversion_silently_did_nothing(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)

        with pytest.raises(ProfileCacheError, match="did not convert"):
            export_profile_archive(
                src, META, crypt_key=KEY, tmp_dir=tmp_path, rekey=lambda ud, f, t: None
            )

    def test_aborts_when_the_kernel_refuses(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)

        def boom(user_data_dir, from_key, to_key):
            raise RuntimeError("fp-crypt-rekey: FROM_MISMATCH: ...")

        with pytest.raises(RuntimeError, match="FROM_MISMATCH"):
            export_profile_archive(src, META, crypt_key=KEY, tmp_dir=tmp_path, rekey=boom)

    def test_refuses_a_profile_whose_records_claim_a_key_its_data_does_not_carry(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=False)
        D.mark_profile_encrypted(src)
        called = []

        with pytest.raises(ProfileCacheError, match="verifier"):
            export_profile_archive(
                src, META, crypt_key=KEY, tmp_dir=tmp_path, rekey=lambda *a: called.append(1)
            )

        assert called == []

    def test_needs_a_key_no_key_no_export_never_a_silent_plain_pack(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTIBROW_API_KEY", raising=False)
        src = seed(tmp_path / "src", encrypted=True)
        called = []

        with pytest.raises(ProfileCacheError, match="key could not be obtained"):
            export_profile_archive(src, META, tmp_dir=tmp_path, rekey=lambda *a: called.append(1))

        assert called == []

    def test_refuses_a_malformed_key_rather_than_handing_it_to_the_kernel(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)
        called = []

        with pytest.raises(ProfileCacheError, match="key could not be obtained"):
            export_profile_archive(
                src, META, crypt_key="not-hex", tmp_dir=tmp_path, rekey=lambda *a: called.append(1)
            )

        assert called == []


class TestTheTemporaryCopy:
    def test_is_gone_after_a_successful_export(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)
        staging = tmp_path / "staging"
        staging.mkdir()

        export_profile_archive(
            src, META, crypt_key=KEY, tmp_dir=staging, rekey=lambda ud, f, t: convert(ud)
        )

        assert list(staging.iterdir()) == []

    def test_is_gone_after_a_failed_export(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)
        staging = tmp_path / "staging"
        staging.mkdir()

        with pytest.raises(ProfileCacheError):
            export_profile_archive(
                src, META, crypt_key=KEY, tmp_dir=staging, rekey=lambda ud, f, t: None
            )

        assert list(staging.iterdir()) == []


class TestExportingAnUnencryptedProfile:
    def test_produces_the_same_archive_it_always_did_with_no_kernel_run(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=False)
        called = []

        data = export_profile_archive(src, META, rekey=lambda *a: called.append(1))

        assert names(data) == names(PT._pack_profile_archive(src, META))
        assert called == []

    def test_still_refuses_a_profile_with_no_identity_yet(self, tmp_path):
        src = tmp_path / "src"
        (src / "user-data").mkdir(parents=True)

        with pytest.raises(ProfileCacheError, match="no identity yet"):
            export_profile_archive(src, META)


class TestKernelResolution:
    """The conversion runs the kernel this profile is pinned to, or none at all."""

    def _stub_catalogue(self, monkeypatch, order):
        monkeypatch.setattr(
            PT._kernel, "refresh_kernel_versions", lambda *a, **k: order.append("refresh")
        )

        def strict(version):
            order.append("strict:{0}".format(version))
            if version == VERSION:
                return K.find_kernel_version(version)
            raise ValueError("Kernel {0} is not in the catalogue.".format(version))

        monkeypatch.setattr(PT._kernel, "find_kernel_version_strict", strict)
        monkeypatch.setattr(
            PT._kernel,
            "ensure_kernel",
            lambda cache_dir, kv, on_progress=None, **kw: (_ for _ in ()).throw(
                RuntimeError("ENSURE_KERNEL_STUB:{0}".format(kv.version))
            ),
        )

    def test_refreshes_the_catalogue_before_resolving_the_version(self, tmp_path, monkeypatch):
        src = seed(tmp_path / "src", encrypted=True)
        order = []
        self._stub_catalogue(monkeypatch, order)

        with pytest.raises(RuntimeError, match="ENSURE_KERNEL_STUB:{0}".format(VERSION)):
            export_profile_archive(
                src, META, crypt_key=KEY, cache_dir=tmp_path, license_token="tok", tmp_dir=tmp_path
            )

        # Not just that both ran - the refresh has to come first, since the lookup
        # is what needs the freshly-registered manifest versions.
        assert order == ["refresh", "strict:{0}".format(VERSION)]

    def test_fails_fast_for_a_profile_pinned_to_a_version_absent_from_the_catalogue(
        self, tmp_path, monkeypatch
    ):
        src = seed(tmp_path / "src", encrypted=True)
        persona = generate_persona(199, "199")
        write_persona(src, persona)
        order = []
        self._stub_catalogue(monkeypatch, order)

        with pytest.raises(ValueError, match="199"):
            export_profile_archive(
                src, META, crypt_key=KEY, cache_dir=tmp_path, license_token="tok", tmp_dir=tmp_path
            )

        # Fails at resolution, never reaching for a kernel to convert on instead.
        assert "ENSURE_KERNEL_STUB" not in "".join(order)

    def test_says_what_is_missing_when_neither_a_kernel_nor_a_cache_dir_is_given(self, tmp_path):
        src = seed(tmp_path / "src", encrypted=True)

        with pytest.raises(ProfileCacheError, match="cache_dir or exe_path"):
            export_profile_archive(src, META, crypt_key=KEY, license_token="tok", tmp_dir=tmp_path)
