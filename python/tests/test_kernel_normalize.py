import json
from pathlib import Path

from antibrow.kernel import (
    ANDROID_MIN_KERNEL_VERSION,
    APP_LOCALE_MIN_KERNEL_VERSION,
    KERNEL_VERSIONS,
    find_kernel_version,
    find_kernel_version_strict,
    kernel_dir,
    kernel_version_at_least,
    normalize_kernel_version,
    parse_kernel_manifest,
    register_kernel_versions,
    all_kernel_versions,
)


def test_normalize_keeps_only_the_major():
    assert normalize_kernel_version("150.0.0.0") == "150"
    assert normalize_kernel_version("151.0.0.0") == "151"
    assert normalize_kernel_version("150") == "150"


def test_normalize_leaves_unknown_shapes_alone():
    assert normalize_kernel_version(None) == ""
    assert normalize_kernel_version("") == ""
    assert normalize_kernel_version("nightly") == "nightly"


def test_baseline_is_major_only():
    assert [kv.version for kv in KERNEL_VERSIONS] == ["150"]
    assert KERNEL_VERSIONS[0].label == "Chrome 150"
    assert ANDROID_MIN_KERNEL_VERSION == "151"
    assert APP_LOCALE_MIN_KERNEL_VERSION == "151"


def test_lookups_accept_legacy_full_versions():
    assert find_kernel_version("150.0.0.0").version == "150"
    assert find_kernel_version_strict("150.0.0.0").version == "150"
    assert kernel_dir("/cache", "150.0.0.0") == Path("/cache") / "kernels" / "150"


def test_at_least_compares_majors_across_shapes():
    assert kernel_version_at_least("151.0.0.0", "151") is True
    assert kernel_version_at_least("150.0.0.0", "151") is False
    assert kernel_version_at_least("152", "151.0.0.0") is True
    assert kernel_version_at_least(None, "151") is False


def test_manifest_ingest_normalizes_and_labels():
    text = json.dumps(
        {
            "versions": [
                {"version": "151.0.0.0", "label": "Chrome 151", "platform": "win64",
                 "download_url": "fp-chromium-151-win64.zip", "build": "2026-08-07 05:17"},
                {"version": "151.0.0.0", "label": "Chrome 151", "platform": "mac-universal",
                 "download_url": "fp-chromium-151-mac-universal.zip", "build": "2026-08-07 14:59"},
                {"version": "149.0.0.0", "platform": "win64",
                 "download_url": "fp-chromium-149-win64.zip", "build": "2026-07-28"},
            ]
        }
    )
    versions = parse_kernel_manifest(text, "https://example.test/fp-browser-versions.json")
    by_version = {kv.version: kv for kv in versions}
    assert set(by_version) == {"151", "149"}
    assert sorted(by_version["151"].platforms) == ["darwin", "win32"]
    assert by_version["151"].platforms["win32"].download_url == "https://example.test/fp-chromium-151-win64.zip"
    assert by_version["149"].label == "Chrome 149"


def test_register_normalizes_a_stale_cache_entry():
    from antibrow.kernel import KernelAsset, KernelVersion

    register_kernel_versions([
        KernelVersion(
            version="152.0.0.0",
            label="Chrome 152",
            platforms={"win32": KernelAsset("https://x/152.zip", "chrome.exe")},
        )
    ])
    versions = [kv.version for kv in all_kernel_versions()]
    assert "152" in versions
    assert "152.0.0.0" not in versions
