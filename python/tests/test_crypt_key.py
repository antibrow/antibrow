"""Whether a launch carries ``--fp-crypt-key``.

Decided by the profile directory's own mark, never by whether the server happens
to hold a key: the kernel binds the key when the profile is created, so both
mistakes are fatal - a key handed to a directory made without one, and a key
withheld from one made with it.
"""

import importlib
import json
from pathlib import Path

import pytest

from antibrow import browser as B
from antibrow import crypt_key as C
from antibrow import kernel as K
from antibrow import license as L
from antibrow.errors import CryptKeyError
from antibrow.launcher import build_launch_args
from antibrow.profile_sync import ArchiveUrls

# `antibrow.__init__` re-exports `config.profile_dir` (a function) under the same
# name, which wins the `antibrow.profile_dir` package attribute over the module.
D = importlib.import_module("antibrow.profile_dir")

KEY = "a" * 64
OTHER_KEY = "b" * 64


def launch_options(**overrides):
    base = dict(
        fp_config_path="/profiles/p1/fp-config.json",
        license_token="token-abc",
        user_data_dir="/profiles/p1/user-data",
        label="p1",
        cdp_port=9222,
        profile_dir="/profiles/p1",
        platform="darwin",
    )
    base.update(overrides)
    return base


class TestLaunchArgs:
    def test_passes_the_key_when_one_is_supplied(self):
        assert "--fp-crypt-key={0}".format(KEY) in build_launch_args(**launch_options(crypt_key=KEY))

    def test_omits_the_flag_entirely_when_no_key_is_supplied(self):
        args = build_launch_args(**launch_options())
        assert not any(arg.startswith("--fp-crypt-key") for arg in args)


class TestTheEncryptedMark:
    def test_survives_a_metadata_rewrite_that_does_not_know_about_it(self, tmp_path):
        D.write_profile_meta(tmp_path, D.ProfileMeta(id="id-1", name="p", origin="local"))
        D.mark_profile_encrypted(tmp_path)

        meta = D.read_profile_meta(tmp_path)
        assert meta.encrypted is True
        # The identity fields are untouched by the mark.
        assert meta.id == "id-1"
        assert D.is_profile_encrypted(tmp_path) is True

    def test_keeps_foreign_keys_the_sdk_does_not_model(self, tmp_path):
        # shareRole is the desktop app's guest marker: this SDK does not model it
        # and must not drop it.
        (tmp_path / "profile.json").write_text(
            json.dumps({"id": "g", "name": "g", "origin": "server", "shareRole": "guest"})
        )
        D.mark_profile_encrypted(tmp_path)

        raw = json.loads((tmp_path / "profile.json").read_text())
        assert raw["shareRole"] == "guest"
        assert raw["encrypted"] is True

    def test_reads_as_unmarked_for_a_directory_with_no_record_at_all(self, tmp_path):
        assert D.is_profile_encrypted(tmp_path) is False


class TestParseCryptKeyBody:
    def test_reads_a_key(self):
        assert C.parse_crypt_key_body({"cryptKey": KEY}) == KEY

    def test_reads_an_explicit_no_key_as_none(self):
        assert C.parse_crypt_key_body({"cryptKey": None, "reason": "no_key"}) is None

    @pytest.mark.parametrize("body", [{"cryptKey": "not-hex"}, {"cryptKey": KEY[:32]}, "nonsense"])
    def test_raises_on_anything_malformed_rather_than_reporting_no_key(self, body):
        with pytest.raises(CryptKeyError):
            C.parse_crypt_key_body(body)


class TestResolveCryptKey:
    def test_returns_nothing_for_an_unmarked_directory_even_with_a_key_on_offer(self, tmp_path):
        calls = []

        def offer():
            calls.append(1)
            return KEY

        assert C.resolve_crypt_key(tmp_path, get_crypt_key=offer) is None
        assert calls == []

    def test_fails_hard_when_a_marked_profile_cannot_get_its_key(self, tmp_path):
        D.mark_profile_encrypted(tmp_path)

        with pytest.raises(CryptKeyError, match="encrypt"):
            C.resolve_crypt_key(tmp_path, get_crypt_key=lambda: None)

    def test_propagates_the_fetch_failure_instead_of_launching_without_the_flag(self, tmp_path):
        D.mark_profile_encrypted(tmp_path)

        def boom():
            raise CryptKeyError("network down")

        with pytest.raises(CryptKeyError, match="network down"):
            C.resolve_crypt_key(tmp_path, get_crypt_key=boom)

    def test_refuses_a_malformed_key(self, tmp_path):
        D.mark_profile_encrypted(tmp_path)

        with pytest.raises(CryptKeyError, match="malformed"):
            C.resolve_crypt_key(tmp_path, crypt_key="not-hex")


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

    def restore_with(writer):
        def download(url, profile_dir):
            writer(Path(profile_dir))
            return True

        monkeypatch.setattr(B, "download_profile_cache", download)

    return restore_with


class TestPrepareLaunch:
    def profile(self, tmp_path):
        directory = tmp_path / "profiles" / "p1"
        directory.mkdir(parents=True)
        return directory

    def plan_for(self, tmp_path, directory, **kwargs):
        return B.prepare_launch(
            "p1", cache_dir=tmp_path, profile_dir=directory, geoip=False, **kwargs
        )

    def test_passes_the_key_of_a_marked_profile_to_the_kernel(self, tmp_path, fake_kernel, paid_license):
        directory = self.profile(tmp_path)
        D.mark_profile_encrypted(directory)

        plan = self.plan_for(tmp_path, directory, sync=False, get_crypt_key=lambda: KEY)

        assert "--fp-crypt-key={0}".format(KEY) in plan.args
        # The key is secret material and must not reach a log through the plan.
        assert "--fp-crypt-key=<redacted>" in plan.redacted_args()

    def test_passes_no_key_for_an_unmarked_profile_even_when_one_is_offered(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        offered = []

        def offer():
            offered.append(1)
            return OTHER_KEY

        plan = self.plan_for(tmp_path, directory, sync=False, get_crypt_key=offer)

        assert offered == []
        assert not any(arg.startswith("--fp-crypt-key") for arg in plan.args)

    def test_never_reaches_the_kernel_when_a_marked_profile_cannot_get_its_key(
        self, tmp_path, fake_kernel, paid_license
    ):
        directory = self.profile(tmp_path)
        D.mark_profile_encrypted(directory)

        def boom():
            raise CryptKeyError("HTTP 404")

        with pytest.raises(CryptKeyError, match="HTTP 404"):
            self.plan_for(tmp_path, directory, sync=False, get_crypt_key=boom)

        assert fake_kernel == []

    def test_launches_with_the_key_after_restoring_an_encrypted_archive(
        self, tmp_path, fake_kernel, paid_license, archive_stub
    ):
        # The owner's second machine: the directory is created by restoring the
        # archive, so the archive is the only thing that can say the data is
        # encrypted. Before crypt-state.json travelled, this launched with no key
        # and the kernel refused to start.
        directory = self.profile(tmp_path)
        archive_stub(lambda target: D.write_crypt_state(target, True))

        plan = self.plan_for(tmp_path, directory, get_crypt_key=lambda: KEY)

        assert "--fp-crypt-key={0}".format(KEY) in plan.args

    def test_ignores_an_offered_key_when_the_restored_archive_says_unencrypted(
        self, tmp_path, fake_kernel, paid_license, archive_stub
    ):
        # A guest whose owner promoted a local profile: the server holds a key (it
        # is minted when the row is created) but the archive was packed from a
        # directory that never used one. Handing it over makes the kernel refuse.
        directory = self.profile(tmp_path)
        D.mark_profile_encrypted(directory)
        archive_stub(lambda target: D.write_crypt_state(target, False))

        plan = self.plan_for(tmp_path, directory, crypt_key=KEY)

        assert not any(arg.startswith("--fp-crypt-key") for arg in plan.args)
