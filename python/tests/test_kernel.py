"""Kernel catalogue, manifest parsing and the download/extract cache.

The download test runs against a throwaway HTTP server on localhost, so the
whole file works offline.
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import stat
import subprocess
import sys
import threading
import zipfile

import pytest

from antibrow import kernel as K
from antibrow.errors import KernelDownloadError, UnsupportedPlatformError

MANIFEST = json.dumps(
    {
        "versions": [
            {
                "version": "151.0.1.2",
                "label": "Chrome 151",
                "platform": "win64",
                "download_url": "fp-chromium-151-win64.zip",
                "exe_rel_path": "chrome.exe",
                "build": "2026-08-01 10:00",
            },
            {
                "version": "150.0.0.0",
                "label": "Chrome 150",
                "platform": "linux64",
                "download_url": "fp-chromium-150-linux64.zip",
                "exe_rel_path": "chrome",
                "build": "2026-07-24 07:09",
            },
            {
                "version": "150.0.0.0",
                "label": "Chrome 150",
                "platform": "win64",
                "download_url": "https://mirror.example.com/fp-chromium-150-win64.zip",
                "build": "0116-passkey 2026-07-22 22:37",
            },
            {
                "version": "150.0.0.0",
                "label": "Chrome 150",
                "platform": "mac-universal",
                "download_url": "fp-chromium-150-mac-universal.zip",
                "build": "2026-07-24 07:09",
            },
            {"version": "bogus", "platform": "macos", "download_url": "x.zip"},
        ]
    }
)


@pytest.fixture(autouse=True)
def clean_registry():
    """Runtime-registered versions are process global - reset between tests."""
    K._registered.clear()
    yield
    K._registered.clear()


# -- catalogue ------------------------------------------------------------


def test_baseline_versions_have_expected_platforms():
    # The baseline is deliberately a single version - the one this release was
    # tested against. Every other kernel, older majors included, comes from the
    # manifest. Its platform set is asserted exactly, not derived from ordering.
    expected_platforms = {
        "150": {"win32", "linux", "linux-arm64", "darwin"},
    }
    assert {kv.version for kv in K.KERNEL_VERSIONS} == set(expected_platforms)
    for kv in K.KERNEL_VERSIONS:
        assert set(kv.platforms) == expected_platforms[kv.version]
        for plat, asset in kv.platforms.items():
            assert asset.download_url.startswith("https://download.antibrow.com/")
            assert asset.exe_rel_path == (
                "chrome.exe"
                if plat == "win32"
                else "Chromium.app/Contents/MacOS/Chromium"
                if plat == "darwin"
                else "chrome"
            )


def test_versions_sort_newest_first_numerically():
    # String sorting would put "150.0.0.9" after "150.0.0.10"; numeric must not.
    assert K.version_sort_key("150.0.0.10") > K.version_sort_key("149.0.0.0")
    assert K.version_sort_key("150.0.0.10") > K.version_sort_key("150.0.0.9")
    ordered = [kv.version for kv in K.all_kernel_versions()]
    assert ordered == sorted(ordered, key=K.version_sort_key, reverse=True)


def test_default_kernel_is_the_newest_baseline_build_for_this_platform():
    default = K.default_kernel_version()
    assert default.version == "150"
    assert default.available_on(K.current_platform())


def test_find_kernel_version_falls_back_to_the_default():
    # Not in the baseline and not registered: an unknown version resolves to the default.
    assert K.find_kernel_version("149.0.0.0").version == K.default_kernel_version().version
    assert K.find_kernel_version("999.0.0.0").version == K.default_kernel_version().version
    assert K.find_kernel_version(None).version == K.default_kernel_version().version


# -- manifest -------------------------------------------------------------


def test_manifest_rows_collapse_into_one_version_per_entry():
    versions = {kv.version: kv for kv in K.parse_kernel_manifest(MANIFEST)}
    assert set(versions) == {"151", "150"}  # the bogus macos row is dropped
    assert set(versions["150"].platforms) == {"win32", "linux", "darwin"}
    assert versions["151"].label == "Chrome 151"


def test_relative_download_urls_resolve_against_the_manifest_origin():
    versions = {kv.version: kv for kv in K.parse_kernel_manifest(MANIFEST)}
    win = versions["151"].platforms["win32"]
    assert win.download_url == "https://download.antibrow.com/fp-chromium-151-win64.zip"
    # ... while an absolute URL in the manifest is left alone.
    assert versions["150"].platforms["win32"].download_url.startswith(
        "https://mirror.example.com/"
    )


def test_manifest_url_override_changes_the_resolution_base():
    versions = {
        kv.version: kv
        for kv in K.parse_kernel_manifest(MANIFEST, "https://cdn.example.org/dir/versions.json")
    }
    assert versions["151"].platforms["win32"].download_url == (
        "https://cdn.example.org/dir/fp-chromium-151-win64.zip"
    )


def test_missing_exe_rel_path_defaults_per_platform():
    versions = {kv.version: kv for kv in K.parse_kernel_manifest(MANIFEST)}
    assert versions["150"].platforms["win32"].exe_rel_path == "chrome.exe"


def test_two_full_versions_of_one_major_collapse_to_the_newest_build():
    # Upstream republishing a major puts two full versions of it on the same
    # platform. The parser keeps the first asset per platform, so row order
    # decides which build every client downloads for that major - and "150.0.0.9"
    # sorts above "150.0.0.10" as text, which is the wrong one.
    manifest = (
        '{"versions":[{"version":"150.0.0.9","platform":"win64",'
        '"download_url":"old.zip","build":"2026-07-01 10:00"},'
        '{"version":"150.0.0.10","platform":"win64",'
        '"download_url":"new.zip","build":"2026-08-01 10:00"}]}'
    )
    parsed = K.parse_kernel_manifest(manifest)
    assert [kv.version for kv in parsed] == ["150"]
    assert parsed[0].platforms["win32"].download_url.endswith("/new.zip")
    assert parsed[0].platforms["win32"].build == "2026-08-01 10:00"


#: The manifest exactly as served by download.antibrow.com on 2026-07-27.
LIVE_MANIFEST = (
    '{"versions":[{"version":"150.0.0.0","label":"Chrome 150","platform":"win64",'
    '"download_url":"fp-chromium-150-win64.zip","exe_rel_path":"chrome.exe",'
    '"build":"0116-passkey 2026-07-22 22:37"},'
    '{"version":"150.0.0.0","label":"Chrome 150","platform":"linux64",'
    '"download_url":"fp-chromium-150-linux64.zip","exe_rel_path":"chrome",'
    '"build":"2026-07-24 07:09"},'
    '{"version":"149.0.0.0","label":"Chrome 149","platform":"linux64",'
    '"download_url":"fp-chromium-149-linux64.zip","exe_rel_path":"chrome",'
    '"build":"2026-07-24 10:56"},'
    '{"version":"149.0.0.0","label":"Chrome 149","platform":"win64",'
    '"download_url":"fp-chromium-149-win64.zip","exe_rel_path":"chrome.exe",'
    '"build":"0116-passkey 2026-07-23 04:35"}]}'
)


def test_the_live_production_manifest_parses():
    parsed = {kv.version: kv for kv in K.parse_kernel_manifest(LIVE_MANIFEST)}
    assert set(parsed) == {"150", "149"}
    for kv in parsed.values():
        assert set(kv.platforms) == {"win32", "linux"}
        assert kv.platforms["win32"].exe_rel_path == "chrome.exe"
        assert kv.platforms["linux"].exe_rel_path == "chrome"
        assert kv.platforms["win32"].build and kv.platforms["linux"].build
    assert parsed["150"].platforms["linux"].download_url == (
        "https://download.antibrow.com/fp-chromium-150-linux64.zip"
    )
    # The published rows must agree with what this SDK compiles in as baseline.
    assert {kv.version for kv in K.KERNEL_VERSIONS} <= set(parsed)


def test_manifest_survives_a_utf8_bom_and_junk_rows():
    parsed = K.parse_kernel_manifest("﻿" + MANIFEST)
    assert {kv.version for kv in parsed} == {"151", "150"}
    assert K.parse_kernel_manifest('{"versions": "nope"}') == []


def test_registering_remote_versions_augments_but_never_overrides():
    # Feeding a full version string still has to hit the major-only entry.
    baseline_url = K.find_kernel_version("150.0.0.0").platforms["win32"].download_url
    K.register_kernel_versions(K.parse_kernel_manifest(MANIFEST))

    catalogue = {kv.version: kv for kv in K.all_kernel_versions()}
    assert "151" in catalogue  # new version appears without an SDK release
    merged = catalogue["150"].platforms["win32"]
    assert merged.download_url == baseline_url  # built-in URL wins
    assert merged.build == "0116-passkey 2026-07-22 22:37"  # but the build is adopted
    assert K.all_kernel_versions()[0].version == "151"


def test_registration_is_idempotent():
    K.register_kernel_versions(K.parse_kernel_manifest(MANIFEST))
    K.register_kernel_versions(K.parse_kernel_manifest(MANIFEST))
    assert len([kv for kv in K.all_kernel_versions() if kv.version == "151"]) == 1


@pytest.fixture
def preserve_registry():
    """Save and restore around a test that registers versions of its own."""
    saved = list(K._registered)
    K._registered.clear()
    yield
    K._registered[:] = saved


def _registered_asset(version, platform):
    return [
        K.KernelVersion(
            version,
            f"Chrome {version}",
            {platform: K.KernelAsset(f"https://x/{version}.zip", "chrome")},
        )
    ]


def test_default_kernel_follows_the_newest_catalogue_version(preserve_registry):
    plat = K.current_platform()
    K.register_kernel_versions(_registered_asset("901", plat))
    assert K.default_kernel_version().version == "901"


def test_a_version_missing_this_platform_never_becomes_the_default(preserve_registry):
    plat = K.current_platform()
    other = "darwin" if plat != "darwin" else "win32"
    K.register_kernel_versions(_registered_asset("902", other))
    assert K.default_kernel_version().version == "150"


# -- install / update status ---------------------------------------------


def install_fake_kernel(cache_dir, version, platform):
    if platform == "win32":
        exe = "chrome.exe"
    elif platform == "darwin":
        exe = "Chromium.app/Contents/MacOS/Chromium"
    else:
        exe = "chrome"
    path = K.kernel_dir(cache_dir, version) / exe
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ fake kernel")
    return path


def test_installed_detection_and_size(tmp_path):
    plat = K.current_platform()
    kv = K.find_kernel_version("150.0.0.0")
    assert not K.is_kernel_installed(tmp_path, kv, plat)
    assert K.kernel_dir_size(tmp_path, kv.version) == 0

    install_fake_kernel(tmp_path, kv.version, plat)
    assert K.is_kernel_installed(tmp_path, kv, plat)
    assert K.list_installed_kernels(tmp_path, plat) == [kv.version]
    assert K.kernel_dir_size(tmp_path, kv.version) == len(b"MZ fake kernel")

    K.delete_kernel(tmp_path, kv.version)
    assert not K.is_kernel_installed(tmp_path, kv, plat)
    K.delete_kernel(tmp_path, kv.version)  # idempotent


def test_a_version_without_a_build_for_this_platform_is_never_installed(tmp_path):
    plat = K.current_platform()
    other = "linux" if plat == "win32" else "win32"
    kv = K.KernelVersion("777.0.0.0", "Chrome 777", {other: K.KernelAsset("http://x/y.zip", "chrome")})
    assert kv.available_on(plat) is False
    assert K.is_kernel_installed(tmp_path, kv, plat) is False
    with pytest.raises(UnsupportedPlatformError):
        kv.asset(plat)


def test_update_status_flags_a_rebuilt_same_version_kernel(tmp_path):
    plat = K.current_platform()
    version = "150.0.0.0"
    install_fake_kernel(tmp_path, version, plat)

    # Not installed by us -> no marker -> "unknown", which must not nag.
    K.register_kernel_versions(K.parse_kernel_manifest(MANIFEST))
    status = K.kernel_update_status(tmp_path, version, plat)
    assert status is not None and status.update_available is False
    adopted = K.installed_kernel_build(tmp_path, version)
    assert adopted  # the current build was adopted rather than reported as drift

    # Now the manifest publishes a newer build under the same version number.
    K._registered.clear()
    K.register_kernel_versions(
        [K.KernelVersion(version, "Chrome 150", {plat: K.KernelAsset("http://x/y.zip", "chrome", "NEWER")})]
    )
    status = K.kernel_update_status(tmp_path, version, plat)
    assert status is not None and status.update_available is True
    assert status.installed_build == adopted and status.available_build == "NEWER"

    assert [s.version for s in K.installed_kernel_updates(tmp_path, plat)] == [
        K.normalize_kernel_version(version)
    ]


def test_update_status_is_none_for_a_kernel_that_is_not_installed(tmp_path):
    assert K.kernel_update_status(tmp_path, "150.0.0.0", K.current_platform()) is None
    assert K.installed_kernel_updates(tmp_path, K.current_platform()) == []


def test_build_marker_round_trip(tmp_path):
    assert K.installed_kernel_build(tmp_path, "1.2.3") is None
    K.write_installed_kernel_build(tmp_path, "1.2.3", "2026-07-24 07:09")
    assert K.installed_kernel_build(tmp_path, "1.2.3") == "2026-07-24 07:09"


# -- download + extract ---------------------------------------------------


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # keep pytest output clean
        pass


@pytest.fixture
def zip_server(tmp_path):
    """Serve tmp_path/www over HTTP on a random localhost port."""
    root = tmp_path / "www"
    root.mkdir()
    handler = type("Handler", (_QuietHandler,), {"directory": str(root)})

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    def factory(*args, **kwargs):
        return handler(*args, directory=str(root), **kwargs)

    server = Server(("127.0.0.1", 0), factory)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield root, "http://127.0.0.1:{0}".format(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()


def make_kernel_zip(path, exe_name, extra_files=(), exe_mode=0o644):
    with zipfile.ZipFile(path, "w") as archive:
        info = zipfile.ZipInfo(exe_name)
        info.external_attr = exe_mode << 16
        archive.writestr(info, "#!/bin/sh\necho fake kernel\n")
        for name in extra_files:
            entry = zipfile.ZipInfo(name)
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, "data")


def make_darwin_kernel_zip(path, build_dir, extra_files=()):
    """A minimal *signed* .app bundle, packed with ditto the way the real
    kernel is published. A plain zipfile-built archive would not have
    anything for ``verify_darwin_bundle_signature`` to check.
    """
    payload = build_dir / "payload"
    app = payload / "Test.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (build_dir / "main.c").write_text("int main(void){return 0;}\n")
    subprocess.run(
        ["clang", "-o", str(app / "Contents" / "MacOS" / "Test"), str(build_dir / "main.c")],
        check=True,
    )
    (app / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>'
        "<key>CFBundleExecutable</key><string>Test</string>"
        "<key>CFBundleIdentifier</key><string>com.antibrow.test</string>"
        "</dict></plist>\n"
    )
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)], check=True)
    for name in extra_files:
        entry = payload / name
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("data")
    subprocess.run(
        ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", str(payload), str(path)],
        check=True,
    )


def test_ensure_kernel_downloads_extracts_and_is_idempotent(tmp_path, zip_server):
    www, base = zip_server
    plat = K.current_platform()
    if plat == "darwin":
        exe_name = "Test.app/Contents/MacOS/Test"
        make_darwin_kernel_zip(www / "kernel.zip", tmp_path, extra_files=["locales/en-US.pak", "icudtl.dat"])
    else:
        exe_name = "chrome.exe" if plat == "win32" else "chrome"
        make_kernel_zip(www / "kernel.zip", exe_name, extra_files=["locales/en-US.pak", "icudtl.dat"])

    kv = K.KernelVersion(
        "0.0.0-test",
        "Test kernel",
        {plat: K.KernelAsset(base + "/kernel.zip", exe_name, build="build-1")},
    )
    cache = tmp_path / "cache"
    messages = []

    exe_path = K.ensure_kernel(cache, kv, messages.append, platform=plat)
    assert exe_path.exists() and str(exe_path).endswith(exe_name)
    assert (K.kernel_dir(cache, kv.version) / "locales" / "en-US.pak").exists()
    assert K.installed_kernel_build(cache, kv.version) == "build-1"
    assert any(m.startswith("Downloading") for m in messages)
    # The downloaded zip must not linger in the cache root.
    assert not list(cache.glob("*.zip"))

    # Second call is a no-op: same path, no new download messages.
    messages.clear()
    assert K.ensure_kernel(cache, kv, messages.append, platform=plat) == exe_path
    assert not any(m.startswith("Downloading kernel") for m in messages)


@pytest.mark.skipif(sys.platform.startswith("win"), reason="POSIX permission bits only")
def test_linux_binaries_get_the_execute_bit(tmp_path, zip_server):
    www, base = zip_server
    make_kernel_zip(www / "kernel.zip", "chrome", extra_files=["chrome_crashpad_handler"])
    kv = K.KernelVersion(
        "0.0.0-linux", "Test", {"linux": K.KernelAsset(base + "/kernel.zip", "chrome")}
    )
    cache = tmp_path / "cache"
    exe_path = K.ensure_kernel(cache, kv, platform="linux")

    # Both the browser and its helpers must be executable, or Chrome aborts with
    # a posix_spawn EPERM inside the crashpad handler.
    for name in ("chrome", "chrome_crashpad_handler"):
        mode = os.stat(exe_path.parent / name).st_mode
        assert mode & stat.S_IXUSR, name


def test_missing_executable_after_extraction_names_antivirus(tmp_path, zip_server):
    www, base = zip_server
    make_kernel_zip(www / "kernel.zip", "something-else")
    plat = K.current_platform()
    exe_name = "chrome.exe" if plat == "win32" else "chrome"
    kv = K.KernelVersion("0.0.0-bad", "Bad", {plat: K.KernelAsset(base + "/kernel.zip", exe_name)})

    with pytest.raises(KernelDownloadError, match="antivirus"):
        K.ensure_kernel(tmp_path / "cache", kv, platform=plat)
    # A half-installed directory would make the next launch fail confusingly.
    assert not K.kernel_dir(tmp_path / "cache", kv.version).exists()


def test_http_errors_surface_as_kernel_download_errors(tmp_path, zip_server):
    _, base = zip_server
    plat = K.current_platform()
    kv = K.KernelVersion(
        "0.0.0-404", "Missing", {plat: K.KernelAsset(base + "/nope.zip", "chrome")}
    )
    with pytest.raises(KernelDownloadError):
        K.ensure_kernel(tmp_path / "cache", kv, platform=plat)


def test_cache_busting_keeps_the_url_intact():
    busted = K._cache_bust("https://example.com/a.zip")
    assert busted.startswith("https://example.com/a.zip?_cb=")
    assert "&_cb=" in K._cache_bust("https://example.com/a.zip?x=1")
    assert K._cache_bust("https://e/a") != K._cache_bust("https://e/a")


def test_kernel_reads_app_locale_from_config_needs_version_and_build():
    from antibrow.kernel import kernel_reads_app_locale_from_config as reads

    # 150 was rebuilt the same day without the patch, so the date alone is not
    # enough; 151's earlier builds predate it, so the version alone is not either.
    assert reads("151.0.0.0", "2026-08-10c") is True
    assert reads("151.0.0.0", "2026-08-08 16:23") is False
    assert reads("150.0.0.0", "2026-08-10") is False
    assert reads("151.0.0.0", None) is False
