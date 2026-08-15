"""A profile packed by one SDK must be understood by the other.

Both SDKs write the same archive, so the encryption marker has to be the same
file, in the same place, with the same bytes. Running the JS SDK from here is not
possible, so its source is read for the two constants and the fact is pinned on
this side byte for byte.
"""

import importlib
import io
import re
import zipfile
from pathlib import Path

import pytest

from antibrow import profile_cache as P
from antibrow.persona import generate_persona, write_persona

D = importlib.import_module("antibrow.profile_dir")

#: The sibling package in the same repository (``js/`` next to ``python/``).
JS_ENGINE = Path(__file__).resolve().parents[2] / "js" / "src" / "engine"

needs_js = pytest.mark.skipif(not JS_ENGINE.is_dir(), reason="the JS package is not checked out here")


def js_const(source: str, name: str) -> str:
    found = re.search(r"{0}\s*=\s*'([^']+)'".format(name), source)
    assert found, "{0} is no longer a plain string constant in the JS SDK".format(name)
    return found.group(1)


@needs_js
class TestTheTwoSdksNameTheSameFiles:
    def test_the_travelling_marker_has_one_name(self):
        source = (JS_ENGINE / "profile-dir.ts").read_text()

        assert js_const(source, "CRYPT_STATE_FILE") == D.CRYPT_STATE_FILE == "crypt-state.json"

    def test_the_machine_local_marker_has_one_name(self):
        source = (JS_ENGINE / "profile-dir.ts").read_text()

        assert js_const(source, "CRYPT_PENDING_FILE") == D.CRYPT_PENDING_FILE == ".crypt-pending"

    def test_both_pack_the_state_file_and_neither_packs_the_pending_one(self):
        root_items = re.search(r"const ROOT_ITEMS = \[([^\]]*)\]", (JS_ENGINE / "profile-cache.ts").read_text())
        assert root_items, "ROOT_ITEMS is no longer a literal array in the JS SDK"

        assert "CRYPT_STATE_FILE" in root_items.group(1)
        assert "CRYPT_PENDING_FILE" not in root_items.group(1)
        assert D.CRYPT_STATE_FILE in P.ROOT_ITEMS
        assert D.CRYPT_PENDING_FILE not in P.ROOT_ITEMS


class TestTheMarkerIsByteCompatible:
    # `JSON.stringify({ encrypted }, null, 2)` on the JS side. Written out in full
    # rather than derived, so a change to either serializer trips this test.
    def test_python_writes_exactly_what_the_js_sdk_writes(self, tmp_path):
        D.write_crypt_state(tmp_path, True)
        assert (tmp_path / D.CRYPT_STATE_FILE).read_text() == '{\n  "encrypted": true\n}'

        D.write_crypt_state(tmp_path, False)
        assert (tmp_path / D.CRYPT_STATE_FILE).read_text() == '{\n  "encrypted": false\n}'

    def test_python_reads_what_the_js_sdk_writes(self, tmp_path):
        (tmp_path / D.CRYPT_STATE_FILE).write_text('{\n  "encrypted": true\n}')
        assert D.read_crypt_state(tmp_path) is True
        assert D.is_profile_encrypted(tmp_path) is True

        (tmp_path / D.CRYPT_STATE_FILE).write_text('{\n  "encrypted": false\n}')
        assert D.read_crypt_state(tmp_path) is False
        assert D.is_profile_encrypted(tmp_path) is False

    def test_the_state_file_travels_at_the_archive_root_under_that_exact_name(self, tmp_path):
        src = tmp_path / "src"
        (src / "user-data" / "Default").mkdir(parents=True)
        (src / "user-data" / "Default" / "Cookies").write_text("cookie-bytes")
        write_persona(src, generate_persona(151, "151"))
        D.mark_profile_encrypted(src)

        data = P.pack_profile_cache(src)

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            assert "crypt-state.json" in zf.namelist()
            assert zf.read("crypt-state.json").decode() == '{\n  "encrypted": true\n}'
