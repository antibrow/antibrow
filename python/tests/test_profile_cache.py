"""The cloud profile cache: what gets packed, and the presigned transfers.

The transfers run against a real localhost HTTP server rather than a patched
``urlopen`` - the interesting failures (status handling, request body, headers)
only show up at the socket level.
"""

import io
import json
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from antibrow import profile_cache as P


def make_profile(root):
    """A profile directory with one of everything the packer has to decide on."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "persona.json").write_text(json.dumps({"seed": "s1"}))
    (root / "passkeys.json").write_text(json.dumps([{"rp": "webauthn.io"}]))
    (root / "fp-config.json").write_text("{}")
    default = root / "user-data" / "Default"
    default.mkdir(parents=True)
    (default / "Cookies").write_text("cookie-db")
    (default / "Cache").mkdir()
    (default / "Cache" / "data_0").write_text("disposable")
    (default / "LOCK").write_text("")
    (root / "user-data" / "Local State").write_text("{}")
    (root / "user-data" / "Crashpad").mkdir()
    (root / "user-data" / "Crashpad" / "report").write_text("boom")
    return root


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return set(zf.namelist())


class _Handler(BaseHTTPRequestHandler):
    """Serves the archive scripted by the server fixture and records PUTs."""

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        status, body = self.server.get_response
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length") or 0)
        self.server.puts.append(
            {"body": self.rfile.read(length), "content_type": self.headers.get("Content-Type")}
        )
        self.send_response(self.server.put_status)
        if self.server.put_etag is not None:
            self.send_header("ETag", self.server.put_etag)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    """A localhost HTTP server standing in for the presigned R2 endpoint."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.get_response = (200, b"")
    httpd.put_status = 200
    httpd.put_etag = None
    httpd.puts = []
    httpd.url = "http://127.0.0.1:{0}/archive.zip".format(httpd.server_address[1])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


# -- packing --------------------------------------------------------------


def test_pack_carries_the_passkey_store_from_the_profile_root(tmp_path):
    data = P.pack_profile_cache(make_profile(tmp_path))

    assert "passkeys.json" in entries(data)


def test_pack_carries_persona_and_whitelisted_user_data(tmp_path):
    names = entries(P.pack_profile_cache(make_profile(tmp_path)))

    assert "persona.json" in names
    assert "user-data/Default/Cookies" in names
    assert "user-data/Local State" in names


def test_pack_skips_caches_lock_files_and_per_launch_config(tmp_path):
    names = entries(P.pack_profile_cache(make_profile(tmp_path)))

    assert not any(name.startswith("user-data/Default/Cache/") for name in names)
    assert not any(name.startswith("user-data/Crashpad/") for name in names)
    assert "user-data/Default/LOCK" not in names
    assert "fp-config.json" not in names


def test_pack_of_a_fresh_profile_is_an_empty_archive(tmp_path):
    assert entries(P.pack_profile_cache(tmp_path)) == set()


# -- unpacking ------------------------------------------------------------


def test_unpack_restores_the_packed_tree(tmp_path):
    data = P.pack_profile_cache(make_profile(tmp_path / "src"))
    dest = tmp_path / "dest"

    P.unpack_profile_cache(data, dest)

    assert (dest / "passkeys.json").read_text() == json.dumps([{"rp": "webauthn.io"}])
    assert (dest / "user-data" / "Default" / "Cookies").read_text() == "cookie-db"


def test_unpack_replaces_user_data_instead_of_merging_into_it(tmp_path):
    # The browser picks the session to restore by the timestamp in the file
    # name, so a leftover Sessions/Session_<newer> from this machine silently
    # outranks the restored one and the profile opens with the wrong tabs.
    src = make_profile(tmp_path / "src")
    sessions = src / "user-data" / "Default" / "Sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / "Session_100").write_text("from-cloud")
    data = P.pack_profile_cache(src)

    dest = tmp_path / "dest"
    dest_default = dest / "user-data" / "Default"
    (dest_default / "Sessions").mkdir(parents=True)
    (dest_default / "Sessions" / "Session_999").write_text("stale-local")
    (dest_default / "Cookies-wal").write_text("stale-wal")
    (dest_default / "Cache").mkdir()
    (dest_default / "Cache" / "data_0").write_text("keep-cache")

    P.unpack_profile_cache(data, dest)

    assert (dest_default / "Sessions" / "Session_100").read_text() == "from-cloud"
    assert not (dest_default / "Sessions" / "Session_999").exists()
    assert not (dest_default / "Cookies-wal").exists()
    assert (dest_default / "Cache" / "data_0").read_text() == "keep-cache"


def test_unpack_leaves_an_item_alone_when_the_archive_never_mentions_it(tmp_path):
    # A live browser can hold Local State open past the shutdown grace period,
    # so packing silently omits it and the archive still uploads fine. The old
    # unconditional clear would then delete the local copy on the next restore
    # and put nothing back - os_crypt.encrypted_key lives there, so every
    # cookie/password becomes undecryptable with no error anywhere.
    src = tmp_path / "src"
    src_default = src / "user-data" / "Default"
    src_default.mkdir(parents=True)
    (src_default / "Cookies").write_text("cloud-cookies")
    # Local State deliberately absent from the source.
    data = P.pack_profile_cache(src)
    assert "user-data/Local State" not in entries(data)

    dest = tmp_path / "dest"
    dest_default = dest / "user-data" / "Default"
    dest_default.mkdir(parents=True)
    (dest_default / "Cookies").write_text("stale-local-cookies")
    (dest / "user-data" / "Local State").write_text("local-encrypted-key")

    P.unpack_profile_cache(data, dest)

    # Default was in the archive: replaced, not merged.
    assert (dest_default / "Cookies").read_text() == "cloud-cookies"
    # Local State was not in the archive at all: left exactly as it was.
    assert (dest / "user-data" / "Local State").read_text() == "local-encrypted-key"


def test_unpack_leaves_the_profile_intact_when_the_archive_is_unreadable(tmp_path):
    dest = make_profile(tmp_path / "dest")

    with pytest.raises(Exception):
        P.unpack_profile_cache(b"not a zip at all", dest)

    assert (dest / "user-data" / "Default" / "Cookies").read_text() == "cookie-db"


def test_device_bound_sessions_are_never_carried_and_are_dropped_on_restore(tmp_path):
    # The private keys live in the OS keystore and cannot be exported, so
    # shipping the records only guarantees the next machine is refused.
    src = make_profile(tmp_path / "src")
    net = src / "user-data" / "Default" / "Network"
    net.mkdir(parents=True, exist_ok=True)
    (net / "Cookies").write_text("ck")
    (net / "Device Bound Sessions").write_text("bound-to-machine-a")
    data = P.pack_profile_cache(src)

    names = entries(data)
    assert "user-data/Default/Network/Cookies" in names
    assert not any("Device Bound Sessions" in name for name in names)

    dest = tmp_path / "dest"
    dest_net = dest / "user-data" / "Default" / "Network"
    dest_net.mkdir(parents=True)
    (dest_net / "Device Bound Sessions").write_text("bound-to-machine-b")

    P.unpack_profile_cache(data, dest)

    assert not (dest_net / "Device Bound Sessions").exists()


def test_unpack_ignores_entries_pointing_outside_the_profile(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../escaped.json", "nope")
        zf.writestr("passkeys.json", "[]")
    dest = tmp_path / "profile"

    P.unpack_profile_cache(buf.getvalue(), dest)

    assert (dest / "passkeys.json").exists()
    assert not (tmp_path / "escaped.json").exists()


# -- presigned transfers --------------------------------------------------


def test_download_unpacks_the_archive_into_the_profile(tmp_path, server):
    server.get_response = (200, P.pack_profile_cache(make_profile(tmp_path / "src")))
    dest = tmp_path / "dest"

    P.download_profile_cache(server.url, dest)

    assert (dest / "passkeys.json").exists()


@pytest.mark.parametrize("status", [403, 404])
def test_download_treats_a_missing_archive_as_a_no_op(tmp_path, server, status):
    server.get_response = (status, b"nothing here")
    dest = tmp_path / "dest"

    assert P.download_profile_cache(server.url, dest) is False
    assert not dest.exists()


def test_download_raises_with_the_status_on_other_errors(tmp_path, server):
    server.get_response = (500, b"boom")

    with pytest.raises(P.ProfileCacheError, match="HTTP 500"):
        P.download_profile_cache(server.url, tmp_path / "dest")


def test_upload_puts_a_zip_carrying_the_passkey_store(tmp_path, server):
    P.upload_profile_cache(make_profile(tmp_path), server.url)

    assert len(server.puts) == 1
    assert server.puts[0]["content_type"] == "application/zip"
    assert "passkeys.json" in entries(server.puts[0]["body"])


def test_upload_returns_the_normalized_etag_as_the_new_generation(tmp_path, server):
    server.put_etag = '"abc123"'

    assert P.upload_profile_cache(make_profile(tmp_path), server.url) == "abc123"


def test_upload_returns_none_when_the_response_names_no_etag(tmp_path, server):
    server.put_etag = None

    assert P.upload_profile_cache(make_profile(tmp_path), server.url) is None


def test_upload_raises_with_the_status_when_the_presign_expired(tmp_path, server):
    server.put_status = 403

    with pytest.raises(P.ProfileCacheError, match="HTTP 403"):
        P.upload_profile_cache(make_profile(tmp_path), server.url)
