"""Whether a profile is encrypted is decided by what the kernel DID.

Never by what the server minted for it: the kernel ignores switches it does not
know, so a build without ``--fp-crypt-key`` support creates an ordinary profile
and reports nothing. The verifier it writes into ``Local State`` is the only
witness, and a mark written before the kernel ever ran is a guess.

Mirrors ``oss/js/tests/engine/crypt-outcome.test.ts``.
"""

import importlib
import json

import pytest
from test_launch_sync import _fake_shutdown, _Stub  # noqa: F401 - shared harness

from antibrow import browser as B
from antibrow import kernel as K
from antibrow import license as L
from antibrow import profile_cache as P
from antibrow.errors import CryptKeyError
from antibrow.profile_sync import ArchiveUrls

D = importlib.import_module("antibrow.profile_dir")

KEY = "a" * 64


def write_local_state(profile_dir, key_bound):
    """What the kernel leaves behind: the verifier is written under ``fp_crypt``."""
    user_data = profile_dir / "user-data"
    user_data.mkdir(parents=True, exist_ok=True)
    (user_data / "Local State").write_text(
        json.dumps({"fp_crypt": {"key_check": "MbA6B9"}} if key_bound else {"os_crypt": None})
    )


@pytest.fixture
def fake_kernel(monkeypatch):
    """Put a stand-in binary where the launch expects one, and count installs."""
    installs = []
    exe_name = "chrome.exe" if K.current_platform() == "win32" else "chrome"

    def ensure(cache_dir, kv=None, on_progress=None, **kwargs):
        version = (kv or K.default_kernel_version()).version
        installs.append(version)
        path = K.kernel_dir(cache_dir, version) / exe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake")
        return path

    monkeypatch.setattr(B._kernel, "ensure_kernel", ensure)
    monkeypatch.setattr(B._kernel, "refresh_kernel_versions", lambda *a, **k: False)
    return installs


@pytest.fixture
def paid_license(monkeypatch):
    monkeypatch.setattr(
        B, "get_license_token", lambda *a, **k: L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=5, sync=True)
    )
    monkeypatch.setenv("ANTIBROW_API_KEY", "adb_test_key")


@pytest.fixture
def archive_stub(monkeypatch):
    """A paid cloud slot whose download writes whatever the test wants."""
    monkeypatch.setattr(B._sync, "ensure_server_profile", lambda *a, **k: True)
    monkeypatch.setattr(
        B._sync,
        "get_profile_archive_urls",
        lambda *a, **k: ArchiveUrls(download_url="https://r2/get", upload_url="https://r2/put"),
    )
    monkeypatch.setattr(B._sync, "get_profile_archive_upload_url", lambda *a, **k: "https://r2/put")

    def restore_with(writer):
        def download(url, profile_dir):
            writer(profile_dir)
            return True

        monkeypatch.setattr(B, "download_profile_cache", download)

    return restore_with


class TestSettleCryptState:
    def test_marks_the_profile_when_the_kernel_wrote_the_verifier(self, tmp_path):
        D.mark_crypt_key_pending(tmp_path)
        write_local_state(tmp_path, True)

        assert D.settle_crypt_state(tmp_path) == "bound"
        assert D.is_profile_encrypted(tmp_path) is True
        assert D.is_crypt_key_pending(tmp_path) is False

    def test_leaves_the_profile_unmarked_when_the_kernel_ignored_the_flag(self, tmp_path):
        D.mark_crypt_key_pending(tmp_path)
        write_local_state(tmp_path, False)

        assert D.settle_crypt_state(tmp_path) == "plain"
        assert D.is_profile_encrypted(tmp_path) is False
        assert D.is_crypt_key_pending(tmp_path) is False

    # "Cannot tell" is its own answer. Collapsing it into "no key" is the mistake
    # that hands a key-bound profile to a kernel with no key.
    def test_changes_nothing_while_the_directory_cannot_answer_yet(self, tmp_path):
        D.mark_crypt_key_pending(tmp_path)

        assert D.settle_crypt_state(tmp_path) == "unknown"
        assert D.is_crypt_key_pending(tmp_path) is True
        assert D.is_profile_encrypted(tmp_path) is False

    def test_keeps_a_marked_profile_marked_when_local_state_is_unreadable(self, tmp_path):
        D.mark_profile_encrypted(tmp_path)
        (tmp_path / "user-data").mkdir(parents=True)
        (tmp_path / "user-data" / "Local State").write_text("{ truncated")

        assert D.settle_crypt_state(tmp_path) == "unknown"
        assert D.is_profile_encrypted(tmp_path) is True

    # The profile this bug created: marked at creation time, then opened by a
    # kernel that dropped the switch. Its data proves the mark wrong.
    def test_clears_a_mark_the_data_contradicts(self, tmp_path):
        D.write_profile_meta(tmp_path, D.ProfileMeta(id="p1", name="p", origin="server"))
        D.mark_profile_encrypted(tmp_path)
        write_local_state(tmp_path, False)

        assert D.settle_crypt_state(tmp_path) == "plain"
        assert D.is_profile_encrypted(tmp_path) is False
        assert D.read_crypt_state(tmp_path) is False
        assert "encrypted" not in json.loads((tmp_path / "profile.json").read_text())
        assert D.read_profile_meta(tmp_path).id == "p1"

    def test_writes_nothing_for_an_ordinary_unmarked_profile(self, tmp_path):
        write_local_state(tmp_path, False)

        assert D.settle_crypt_state(tmp_path) == "plain"
        assert D.read_crypt_state(tmp_path) is None

    # The marker is about one directory's next launch, so it must not travel:
    # restored on a second machine it would demand a key for data that may never
    # have been bound to one.
    def test_keeps_the_pending_marker_out_of_the_cloud_archive(self, tmp_path):
        D.mark_crypt_key_pending(tmp_path)
        write_local_state(tmp_path, False)

        import io
        import zipfile

        with zipfile.ZipFile(io.BytesIO(P.pack_profile_cache(tmp_path))) as zf:
            assert D.CRYPT_PENDING_FILE not in set(zf.namelist())


class TestTheLaunchThatBindsTheKey:
    def profile(self, tmp_path):
        directory = tmp_path / "profiles" / "p1"
        directory.mkdir(parents=True)
        return directory

    def plan_for(self, tmp_path, directory, **kwargs):
        return B.prepare_launch("p1", cache_dir=tmp_path, profile_dir=directory, geoip=False, **kwargs)

    def test_passes_the_key_on_the_first_launch_before_anything_is_marked(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        D.mark_crypt_key_pending(directory)

        plan = self.plan_for(tmp_path, directory, sync=False, get_crypt_key=lambda: KEY)

        assert "--fp-crypt-key={0}".format(KEY) in plan.args
        assert D.is_profile_encrypted(directory) is False

    def test_never_spawns_the_kernel_when_a_pending_profile_cannot_get_a_key(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        D.mark_crypt_key_pending(directory)

        with pytest.raises(CryptKeyError, match="encrypt"):
            self.plan_for(tmp_path, directory, sync=False, get_crypt_key=lambda: None)

        assert fake_kernel == []

    # A restored archive is what tells the second machine the data is encrypted;
    # the settlement runs after the restore, so it never judges an empty directory.
    def test_does_not_unmark_a_directory_whose_archive_has_not_been_restored_yet(
        self, tmp_path, fake_kernel, paid_license, archive_stub
    ):
        directory = self.profile(tmp_path)

        def restore(target):
            write_local_state(target, True)
            D.write_crypt_state(target, True)

        archive_stub(restore)

        plan = self.plan_for(tmp_path, directory, get_crypt_key=lambda: KEY)

        assert "--fp-crypt-key={0}".format(KEY) in plan.args
        assert D.is_profile_encrypted(directory) is True


class TestAProfileMismarkedByTheCreateTimeGuess:
    def profile(self, tmp_path):
        directory = tmp_path / "profiles" / "p1"
        directory.mkdir(parents=True)
        return directory

    def test_launches_it_with_no_key_once_its_own_data_proves_it_plain(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        D.mark_profile_encrypted(directory)
        write_local_state(directory, False)
        offered = []

        plan = B.prepare_launch(
            "p1",
            cache_dir=tmp_path,
            profile_dir=directory,
            geoip=False,
            sync=False,
            get_crypt_key=lambda: offered.append(1) or KEY,
        )

        assert offered == []
        assert not any(arg.startswith("--fp-crypt-key") for arg in plan.args)
        assert D.is_profile_encrypted(directory) is False

    # The absolute rule, unchanged by any of the above: real encrypted data with
    # no key available fails, and the kernel is never started.
    def test_still_refuses_when_the_data_really_is_key_bound_and_no_key_can_be_had(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        D.mark_profile_encrypted(directory)
        write_local_state(directory, True)

        with pytest.raises(CryptKeyError, match="encrypt"):
            B.prepare_launch(
                "p1",
                cache_dir=tmp_path,
                profile_dir=directory,
                geoip=False,
                sync=False,
                get_crypt_key=lambda: None,
            )

        assert fake_kernel == []
        assert D.is_profile_encrypted(directory) is True


class TestSettlingOnClose:
    """The mark is written after the kernel exits and before the archive is packed."""

    def _session(self, tmp_path, monkeypatch, plan, log):
        monkeypatch.setattr(B, "shutdown_kernel", _fake_shutdown(log))
        stub = _Stub(log, "browser")
        return B.Antibrow(plan, stub, "ws://127.0.0.1:1/x", _Stub(log, "pw"), stub, stub)

    def _plan(self, tmp_path, fake_kernel, monkeypatch, directory):
        monkeypatch.setattr(B, "download_profile_cache", lambda url, profile_dir: False)
        return B.prepare_launch(
            "p1", cache_dir=tmp_path, profile_dir=directory, geoip=False, get_crypt_key=lambda: KEY
        )

    def test_marks_the_profile_and_the_packed_archive_agrees(
        self, tmp_path, fake_kernel, paid_license, archive_stub, monkeypatch
    ):
        directory = tmp_path / "profiles" / "p1"
        directory.mkdir(parents=True)
        D.mark_crypt_key_pending(directory)
        archive_stub(lambda target: None)
        plan = self._plan(tmp_path, fake_kernel, monkeypatch, directory)
        packed = []
        monkeypatch.setattr(
            B, "upload_profile_cache", lambda profile_dir, url: packed.append(D.read_crypt_state(profile_dir)) or "etag"
        )
        session = self._session(tmp_path, monkeypatch, plan, [])

        write_local_state(directory, True)
        session.close()

        assert D.is_profile_encrypted(directory) is True
        assert D.is_crypt_key_pending(directory) is False
        assert packed == [True]

    def test_leaves_a_kernel_that_ignored_the_flag_unmarked_and_the_archive_claims_nothing(
        self, tmp_path, fake_kernel, paid_license, archive_stub, monkeypatch
    ):
        directory = tmp_path / "profiles" / "p1"
        directory.mkdir(parents=True)
        D.mark_crypt_key_pending(directory)
        archive_stub(lambda target: None)
        plan = self._plan(tmp_path, fake_kernel, monkeypatch, directory)
        packed = []
        monkeypatch.setattr(
            B, "upload_profile_cache", lambda profile_dir, url: packed.append(D.read_crypt_state(profile_dir)) or "etag"
        )
        session = self._session(tmp_path, monkeypatch, plan, [])

        write_local_state(directory, False)
        session.close()

        assert D.is_profile_encrypted(directory) is False
        # Nothing was ever marked, so there is nothing to unmark: the archive
        # simply carries no claim, which is what an unencrypted profile looks like.
        assert packed == [None]

        # ... and the profile keeps launching, with no key and no key lookup.
        offered = []
        again = B.prepare_launch(
            "p1",
            cache_dir=tmp_path,
            profile_dir=directory,
            geoip=False,
            sync=False,
            get_crypt_key=lambda: offered.append(1) or KEY,
        )

        assert offered == []
        assert not any(arg.startswith("--fp-crypt-key") for arg in again.args)
