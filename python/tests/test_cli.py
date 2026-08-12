"""The CLI must work offline, without a key, and without a kernel installed."""

from __future__ import annotations

import pytest

from antibrow import __version__
from antibrow import config as C
from antibrow import kernel as K
from antibrow.cli import main


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv(C.ENV_CACHE_DIR, str(tmp_path / "cache"))
    for var in (C.ENV_API_KEY, C.ENV_API_KEY_LEGACY, C.ENV_LICENSE_TOKEN):
        monkeypatch.delenv(var, raising=False)
    # `info` / `install` refresh the kernel manifest; keep the suite offline.
    monkeypatch.setattr(K, "refresh_kernel_versions", lambda *a, **k: False)
    monkeypatch.setattr(K, "refresh_kernel_catalogue", lambda *a, **k: False)


def test_version_prints_the_sdk_and_default_kernel(capsys):
    assert main(["version"]) == 0
    out = capsys.readouterr().out
    assert __version__ in out
    assert K.default_kernel_version().version in out


def test_info_works_with_nothing_installed_and_no_key(capsys):
    assert main(["info"]) == 0
    out = capsys.readouterr().out
    assert "cache dir" in out
    assert "nothing installed yet" in out
    assert "profiles are created on first launch" in out
    assert "NOT CONFIGURED" in out


def test_info_lists_installed_kernels_and_profiles(tmp_path, capsys):
    cache = tmp_path / "cache"
    version = K.default_kernel_version().version
    plat = K.current_platform()
    if plat == "win32":
        exe = "chrome.exe"
    elif plat == "darwin":
        exe = "Chromium.app/Contents/MacOS/Chromium"
    else:
        exe = "chrome"
    path = K.kernel_dir(cache, version) / exe
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 2048)
    (cache / "profiles" / "shopper-01").mkdir(parents=True)

    assert main(["info"]) == 0
    out = capsys.readouterr().out
    assert "[x] {0}".format(version) in out
    assert "default for new profiles" in out
    assert "shopper-01" in out


def test_no_arguments_prints_help(capsys):
    assert main([]) == 0
    assert "usage" in capsys.readouterr().out.lower()


def test_install_rejects_an_unknown_version(capsys):
    assert main(["install", "--version", "1.2.3.4"]) == 2
    assert "unknown kernel version" in capsys.readouterr().err


def test_install_accepts_the_full_version_older_releases_documented(capsys, monkeypatch):
    # The shipped CLI help advertised a full version, and CI pipelines pinned it.
    major = K.default_kernel_version().version
    monkeypatch.setattr(K, "ensure_kernel", lambda *a, **k: "/kernels/chrome")
    monkeypatch.setattr(K, "kernel_dir_size", lambda *a, **k: 0)
    assert main(["install", "--version", "{0}.7.7.7".format(major)]) == 0
    assert "({0})".format(major) in capsys.readouterr().out


def test_info_prints_the_normalized_kernel_of_a_legacy_profile(tmp_path, capsys):
    import json

    from antibrow.persona import generate_persona

    profile = tmp_path / "cache" / "profiles" / "legacy-01"
    profile.mkdir(parents=True)
    persona = generate_persona(150, "150").to_dict()
    persona["kernelVersion"] = "150.7.7.7"
    (profile / "persona.json").write_text(json.dumps(persona), encoding="utf-8")
    assert main(["info"]) == 0
    out = capsys.readouterr().out
    # What `info` prints must be a version `install --version` accepts.
    assert "legacy-01" in out
    assert "kernel 150\n" in out
    assert "150.7.7.7" not in out


def test_login_without_a_key_or_a_tty_fails_cleanly(capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert main(["login"]) == 2
    assert "no API key given" in capsys.readouterr().err


def test_login_stores_the_key_after_the_server_accepts_it(capsys, monkeypatch, tmp_path):
    from antibrow import license as L

    monkeypatch.setattr(
        L, "fetch_license_token", lambda key, server: L.LicenseInfo("tok", 2**31, mi=20, sync=True)
    )
    assert main(["login", "--key", "ab_live_demo"]) == 0
    out = capsys.readouterr().out
    assert "key stored" in out
    assert "concurrent browsers: 20" in out
    assert L.read_key_file() == "ab_live_demo"


def test_login_reports_a_rejected_key_and_stores_nothing(capsys, monkeypatch):
    from antibrow import license as L
    from antibrow.errors import LicenseError

    def boom(key, server):
        raise LicenseError("Authentication failed: the API key was rejected")

    monkeypatch.setattr(L, "fetch_license_token", boom)
    assert main(["login", "--key", "nope"]) == 1
    assert "Authentication failed" in capsys.readouterr().err
    assert L.read_key_file() is None


def test_clear_temp_accepts_zero(capsys):
    assert main(["clear-temp", "--older-than=0"]) == 0
    assert "0 temporary profile(s)" in capsys.readouterr().out


@pytest.mark.parametrize("value", ["-5", "nan", "inf", "-inf"])
def test_clear_temp_rejects_negative_or_non_finite_older_than(value, capsys):
    assert main(["clear-temp", "--older-than={0}".format(value)]) == 1
    err = capsys.readouterr().err
    assert "invalid" in err.lower()
    assert "--older-than" in err
