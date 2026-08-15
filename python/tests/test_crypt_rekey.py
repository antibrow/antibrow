"""The kernel's one-shot re-encryption: argv, refusal tokens, and the verifier.

Mirrors ``oss/js/tests/engine/crypt-rekey.test.ts``.
"""

import importlib
import json
import os
import stat
import sys

import pytest

from antibrow.crypt_rekey import (
    REKEY_TIMEOUT_CODE,
    build_rekey_args,
    parse_rekey_code,
    run_crypt_rekey,
)
from antibrow.errors import CryptRekeyError

D = importlib.import_module("antibrow.profile_dir")

KEY = "a" * 64


def write_local_state(user_data_dir, value):
    user_data_dir.mkdir(parents=True, exist_ok=True)
    (user_data_dir / "Local State").write_text(json.dumps(value))


class TestBuildRekeyArgs:
    def test_carries_both_switches_the_user_data_dir_and_the_licence(self):
        args = build_rekey_args(
            user_data_dir="/p/user-data",
            from_key=KEY,
            to_key="none",
            license_token="tok-1",
            platform="darwin",
        )

        assert "--fp-crypt-rekey-from={0}".format(KEY) in args
        assert "--fp-crypt-rekey-to=none" in args
        assert "--user-data-dir=/p/user-data" in args
        assert "--fp-license=tok-1" in args

    # The kernel rejects the combination outright (BAD_ARGS): with both present
    # there is no answer to "which key wins".
    def test_never_passes_fp_crypt_key_alongside_the_rekey_switches(self):
        args = build_rekey_args(
            user_data_dir="/p/user-data",
            from_key=KEY,
            to_key="none",
            license_token="tok-1",
            platform="darwin",
        )

        assert not any(arg.startswith("--fp-crypt-key=") for arg in args)

    @pytest.mark.parametrize("platform", ["linux", "linux-arm64"])
    def test_adds_the_container_switches_only_on_linux(self, platform):
        linux = build_rekey_args(
            user_data_dir="/u", from_key="none", to_key=KEY, license_token="t", platform=platform
        )
        mac = build_rekey_args(
            user_data_dir="/u", from_key="none", to_key=KEY, license_token="t", platform="darwin"
        )

        assert "--no-sandbox" in linux
        assert "--no-sandbox" not in mac


# The prose has already changed once between kernel builds; the token has not.
class TestParseRekeyCode:
    def test_reads_the_token_out_of_a_refusal_line(self):
        assert (
            parse_rekey_code(
                "fp-crypt-rekey: FROM_MISMATCH: --fp-crypt-rekey-from does not match this "
                "profile (existing data left untouched)"
            )
            == "FROM_MISMATCH"
        )

    def test_reads_the_tokens_the_crypt_key_half_emits_too(self):
        assert (
            parse_rekey_code(
                "fp-crypt-key: REKEY_PENDING: this profile is in the middle of a "
                "--fp-crypt-rekey conversion; re-run the same rekey command to finish it."
            )
            == "REKEY_PENDING"
        )
        assert (
            parse_rekey_code(
                "fp-crypt-key: KEY_REQUIRED: this profile requires an external key; none was supplied."
            )
            == "KEY_REQUIRED"
        )

    def test_says_nothing_when_the_output_carries_no_token(self):
        assert parse_rekey_code("Segmentation fault") is None
        assert parse_rekey_code("") is None


class TestProfileCryptMarker:
    def test_reports_key_bound_while_the_verifier_is_there(self, tmp_path):
        write_local_state(tmp_path, {"fp_crypt": {"key_check": "AAAA"}, "user_experience_metrics": {}})

        assert D.profile_crypt_marker(tmp_path) == "key-bound"

    # A half-converted profile is refused by the kernel at launch, so it is not
    # exportable either - and it is not "plain" just because key_check is gone.
    def test_reports_key_bound_for_a_pending_conversion(self, tmp_path):
        write_local_state(tmp_path, {"fp_crypt": {"rekey_pending": {"from": "fp1", "to": "fp2"}}})

        assert D.profile_crypt_marker(tmp_path) == "key-bound"

    def test_reports_plain_once_the_whole_fp_crypt_block_is_gone(self, tmp_path):
        write_local_state(tmp_path, {"user_experience_metrics": {}})

        assert D.profile_crypt_marker(tmp_path) == "plain"

    def test_reports_plain_for_an_explicit_null_which_is_how_the_kernel_leaves_it(self, tmp_path):
        write_local_state(tmp_path, {"fp_crypt": None})

        assert D.profile_crypt_marker(tmp_path) == "plain"

    # "Cannot tell" must never read as "no key": that is the answer that ships a
    # broken archive.
    def test_reports_unreadable_for_a_missing_or_unparseable_local_state(self, tmp_path):
        assert D.profile_crypt_marker(tmp_path / "nothing-here") == "unreadable"

        (tmp_path / "Local State").write_text("{not json")
        assert D.profile_crypt_marker(tmp_path) == "unreadable"


# Spawning a stand-in binary needs an executable script, so POSIX only. The argv,
# exit-code and token handling above are platform-independent.
posix = pytest.mark.skipif(sys.platform == "win32", reason="needs an executable stand-in binary")


def fake_kernel(tmp_path, body):
    path = tmp_path / "fake-kernel"
    path.write_text("#!{0}\n{1}\n".format(sys.executable, body))
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


@posix
class TestRunCryptRekeyDrivesARealProcess:
    def test_resolves_when_the_kernel_reports_ok(self, tmp_path):
        argv_file = tmp_path / "argv.json"
        exe = fake_kernel(
            tmp_path,
            "import json, sys\n"
            "open({0!r}, 'w').write(json.dumps(sys.argv[1:]))\n".format(str(argv_file))
            + "print('fp-crypt-rekey: OK: 4 files, 210 values converted')",
        )

        run_crypt_rekey(
            exe_path=exe,
            user_data_dir="/p/user-data",
            from_key="d" * 64,
            to_key="none",
            license_token="tok-9",
        )

        assert "--fp-crypt-rekey-from={0}".format("d" * 64) in json.loads(argv_file.read_text())

    def test_turns_a_refusal_into_an_error_carrying_the_token_and_the_exit_code(self, tmp_path):
        exe = fake_kernel(
            tmp_path,
            "import sys\n"
            "sys.stderr.write('fp-crypt-rekey: FROM_MISMATCH: does not match this profile\\n')\n"
            "sys.exit(7)",
        )

        with pytest.raises(CryptRekeyError) as caught:
            run_crypt_rekey(
                exe_path=exe, user_data_dir="/p/user-data", from_key="e" * 64, to_key="none", license_token="t"
            )

        assert caught.value.code == "FROM_MISMATCH"
        assert caught.value.exit_code == 7

    def test_fails_loudly_on_a_non_zero_exit_with_no_token_at_all(self, tmp_path):
        exe = fake_kernel(tmp_path, "import sys; sys.exit(1)")

        with pytest.raises(CryptRekeyError, match="exit code 1"):
            run_crypt_rekey(
                exe_path=exe, user_data_dir="/u", from_key="f" * 64, to_key="none", license_token="t"
            )

    # The regression this guards: a kernel that does not understand the rekey
    # switches ignores them and opens a full browser instead of exiting, so this
    # never produces a refusal token - it just never exits. The message has to
    # read differently from a refusal, or a timeout is indistinguishable from
    # "the kernel said FROM_MISMATCH" in a bug report.
    def test_distinguishes_a_timeout_from_a_refusal(self, tmp_path):
        exe = fake_kernel(tmp_path, "import time; time.sleep(30)")

        with pytest.raises(CryptRekeyError) as caught:
            run_crypt_rekey(
                exe_path=exe,
                user_data_dir="/u",
                from_key="g" * 64,
                to_key="none",
                license_token="t",
                timeout=0.5,
            )

        assert caught.value.code == REKEY_TIMEOUT_CODE
        assert caught.value.exit_code is None
        assert "did not finish" in str(caught.value)
        assert "FROM_MISMATCH" not in str(caught.value)
        assert "exit code" not in str(caught.value)

    # The conversion takes a licence slot exactly as a launch does, so a machine
    # already running its allowance reports LICENSE - and that cause's fix (close
    # a browser) is the opposite of the other three the same token covers.
    def test_says_what_to_do_about_a_licence_slot_a_browser_is_holding(self, tmp_path):
        exe = fake_kernel(
            tmp_path,
            "import sys\n"
            "sys.stderr.write('fp-crypt-rekey: LICENSE: missing, invalid or expired --fp-license\\n')\n"
            "sys.exit(7)",
        )

        with pytest.raises(CryptRekeyError, match="close one and export again"):
            run_crypt_rekey(
                exe_path=exe, user_data_dir="/u", from_key=KEY, to_key="none", license_token="t"
            )

    def test_reports_a_missing_kernel_binary_rather_than_raising_oserror(self, tmp_path):
        with pytest.raises(CryptRekeyError, match="Could not run the browser kernel"):
            run_crypt_rekey(
                exe_path=tmp_path / "not-there",
                user_data_dir="/u",
                from_key=KEY,
                to_key="none",
                license_token="t",
            )


def test_the_stand_in_is_actually_executable(tmp_path):
    """Guards the harness itself: a non-executable stand-in fails every test above."""
    exe = fake_kernel(tmp_path, "pass")
    assert os.access(exe, os.X_OK)
