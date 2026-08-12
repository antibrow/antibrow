import copy
import io
import json
import urllib.error
import urllib.request

import pytest

from antibrow import devices, kernel
from antibrow.errors import KernelDownloadError
from antibrow.launcher import build_launch_args

_SAMPLE = {
    "os": "android",
    "model": "SM-S918U",
    "ua": "UA {major}",
    "navigator": {"hardwareConcurrency": 8, "deviceMemory": 8},
    "screen": {"width": 1, "height": 2, "devicePixelRatio": 3},
    "webgl": {"unmaskedRenderer": "r", "unmaskedVendor": "v"},
}


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = json.dumps(payload).encode()
        self.status = status

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_real_device_sends_key_and_user_agent(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["headers"] = {k.lower(): v for k, v in req.header_items()}
        return _Resp({"device": _SAMPLE})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    device = devices.fetch_real_device("android", key="adb_test", server="https://example.test")

    assert device["os"] == "android"
    assert seen["url"] == "https://example.test/api/v1/devices/pick?os=android"
    assert seen["headers"]["authorization"] == "Bearer adb_test"
    # Cloudflare blocks the stock urllib agent outright.
    assert "python-urllib" not in seen["headers"]["user-agent"].lower()


def test_fetch_real_device_surfaces_the_plan_error(monkeypatch):
    # The shape the server actually sends (ApiError.toJSON): a nested object,
    # not a string. Mocking a bare string here is what let the real 403 message
    # reach the user as a bare "HTTP 403".
    body = {"error": {"code": "FORBIDDEN",
                      "message": "The Captured-machine fingerprint library requires a paid plan."}}

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 403, "Forbidden", {}, io.BytesIO(json.dumps(body).encode()),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="requires a paid plan"):
        devices.fetch_real_device("android", key="adb_free")


def test_fetch_real_device_still_reads_a_plain_string_error(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 502, "Bad Gateway", {},
            io.BytesIO(json.dumps({"error": "upstream said no"}).encode()),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="upstream said no"):
        devices.fetch_real_device("android", key="adb_test")


def test_fetch_real_device_falls_back_to_the_status_code(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 502, "Bad Gateway", {}, io.BytesIO(b"<html>gateway</html>"),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="HTTP 502"):
        devices.fetch_real_device("android", key="adb_test")


@pytest.mark.parametrize(
    "path",
    [("navigator", "hardwareConcurrency"), ("navigator", "deviceMemory"), ("screen", "devicePixelRatio")],
)
def test_fetch_real_device_guards_the_numbers_persona_generation_reads(monkeypatch, path):
    section, key = path
    device = copy.deepcopy(_SAMPLE)
    device[section].pop(key)

    def fake_urlopen(req, timeout=None):
        return _Resp({"device": device})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match=key):
        devices.fetch_real_device("android", key="adb_test")


def test_fetch_real_device_refuses_a_malformed_row(monkeypatch):
    # device_to_persona_parts reads navigator, screen.height and the unmasked
    # webgl pair with no guard of its own - a partial row must never slip past
    # here quietly, or the persona merge silently keeps synthetic values for
    # whatever field was missing.
    def fake_urlopen(req, timeout=None):
        return _Resp({"device": {"os": "android", "ua": "UA {major}", "screen": {"width": 1},
                                 "webgl": {"unmaskedRenderer": "r"}}})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="malformed device"):
        devices.fetch_real_device("android", key="adb_test")


_MIN = kernel.ANDROID_MIN_KERNEL_VERSION


def test_kernel_supports_android_accepts_the_floor_and_above():
    assert kernel.kernel_supports_android(_MIN) is True
    assert kernel.kernel_supports_android("152") is True
    assert kernel.kernel_supports_android("200") is True


def test_kernel_supports_android_rejects_below_the_floor():
    assert kernel.kernel_supports_android("150") is False
    assert kernel.kernel_supports_android("149") is False
    assert kernel.kernel_supports_android(None) is False
    assert kernel.kernel_supports_android("") is False


def test_kernel_supports_android_normalizes_a_legacy_full_version():
    # An Android profile created before kernels went major-only pins one of these.
    assert kernel.kernel_supports_android("151.7.7.7") is True
    assert kernel.kernel_supports_android("150.7.7.7") is False


def test_kernel_supports_android_ignores_the_build_stamp():
    # A missing or stale stamp used to reject a perfectly capable kernel: the
    # compiled-in baseline carries no build at all, and a manifest row may omit
    # it. The second argument is kept only so older callers keep working.
    assert kernel.kernel_supports_android(_MIN, None) is True
    assert kernel.kernel_supports_android(_MIN, "2026-08-02") is True
    assert kernel.kernel_supports_android("152", None) is True
    assert kernel.kernel_supports_android(_MIN, "proxyauth-fix+utf8label 2026-07-28") is True
    # ...but it never rescues a version below the floor.
    assert kernel.kernel_supports_android("150", "2026-09-01 00:00") is False


def test_find_kernel_version_strict_refuses_to_substitute():
    # The Android kernel is not in the compiled-in baseline; the lenient lookup
    # silently answers with the default, which is a different Chrome major.
    assert kernel.find_kernel_version(_MIN).version == kernel.default_kernel_version().version
    with pytest.raises(KernelDownloadError, match="not in the catalogue"):
        kernel.find_kernel_version_strict(_MIN)
    known = kernel.default_kernel_version().version
    assert kernel.find_kernel_version_strict(known).version == known


def test_android_launch_args_size_the_window():
    args = build_launch_args(
        fp_config_path="/p/fp.json", license_token="t", user_data_dir="/p/ud",
        label="demo", cdp_port=9222, platform="win32", android_screen=(412, 917),
    )
    assert "--window-size=412,917" in args


def test_desktop_launch_args_have_no_window_size():
    args = build_launch_args(
        fp_config_path="/p/fp.json", license_token="t", user_data_dir="/p/ud",
        label="demo", cdp_port=9222, platform="win32",
    )
    assert not any(a.startswith("--window-size=") for a in args)


def test_headless_android_keeps_the_persona_screen_size():
    # Hidden or not, innerWidth == screen.width is part of the phone's identity.
    args = build_launch_args(
        fp_config_path="/p/fp.json", license_token="t", user_data_dir="/p/ud",
        label="demo", cdp_port=9222, platform="win32", headless=True, android_screen=(412, 917),
    )
    assert args.count("--window-size=412,917") == 1
    assert "--window-position=-10000,-10000" in args
