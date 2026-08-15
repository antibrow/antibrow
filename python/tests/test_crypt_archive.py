"""The encryption marker travels with the data it describes.

Encryption is a property of the profile's DATA. Left behind, the machine that
restores the archive launches without the key the cookies in it were written
under, and the kernel refuses to start.
"""

import importlib
import io
import json
import zipfile

from antibrow import profile_cache as P
from antibrow.persona import generate_persona, write_persona
from antibrow.portable import (
    PortableProfileMeta,
    export_profile_archive,
    import_profile_archive,
)

D = importlib.import_module("antibrow.profile_dir")


def seed_profile(root):
    (root / "user-data" / "Default").mkdir(parents=True)
    (root / "user-data" / "Default" / "Cookies").write_text("cookie-bytes")
    write_persona(root, generate_persona(151, "151"))
    return root


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return set(zf.namelist())


class TestTheCryptStateTravels:
    def test_packs_and_restores_the_marker(self, tmp_path):
        src = seed_profile(tmp_path / "src")
        D.mark_profile_encrypted(src)

        dst = tmp_path / "dst"
        P.unpack_profile_cache(P.pack_profile_cache(src), dst)

        assert D.read_crypt_state(dst) is True
        assert D.is_profile_encrypted(dst) is True

    def test_leaves_an_unencrypted_profile_saying_nothing_at_all(self, tmp_path):
        src = seed_profile(tmp_path / "src")

        assert D.CRYPT_STATE_FILE not in entries(P.pack_profile_cache(src))

    def test_never_carries_profile_json_so_a_guest_marker_cannot_travel(self, tmp_path):
        src = seed_profile(tmp_path / "src")
        (src / "profile.json").write_text(
            json.dumps({"id": "id-1", "name": "shared", "origin": "server", "shareRole": "guest"})
        )
        D.mark_profile_encrypted(src)

        names = entries(P.pack_profile_cache(src))

        assert "profile.json" not in names
        assert D.CRYPT_STATE_FILE in names

    def test_the_restored_state_file_overrules_a_local_record_that_disagrees(self, tmp_path):
        directory = tmp_path / "p"
        directory.mkdir()
        # The local record says encrypted (this machine created it that way); the
        # state file restored beside the data says otherwise. The data wins.
        (directory / "profile.json").write_text(json.dumps({"id": "x", "name": "x", "encrypted": True}))
        D.write_crypt_state(directory, False)

        assert D.is_profile_encrypted(directory) is False

    def test_falls_back_to_the_local_record_for_archives_predating_the_state_file(self, tmp_path):
        directory = tmp_path / "p"
        directory.mkdir()
        (directory / "profile.json").write_text(json.dumps({"id": "x", "name": "x", "encrypted": True}))

        assert D.read_crypt_state(directory) is None
        assert D.is_profile_encrypted(directory) is True


class TestImportingIntoADirectoryThatHeldAnEncryptedProfile:
    def test_drops_the_previous_occupants_marker(self, tmp_path):
        src = seed_profile(tmp_path / "src")
        archive = export_profile_archive(src, PortableProfileMeta(name="imported", kernel_version="151"))

        dst = tmp_path / "dst"
        D.mark_profile_encrypted(dst)
        import_profile_archive(archive, dst)

        assert D.is_profile_encrypted(dst) is False

    def test_keeps_a_marker_the_imported_archive_brought_itself(self, tmp_path):
        src = seed_profile(tmp_path / "src")
        D.mark_profile_encrypted(src)

        # A raw cloud archive, imported through the legacy path.
        dst = tmp_path / "dst"
        import_profile_archive(P.pack_profile_cache(src), dst)

        assert D.is_profile_encrypted(dst) is True
