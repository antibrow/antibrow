"""The on-disk manifest cache, shared with the Node SDK (bare camelCase list)."""

import json
import os
import time

import pytest

from antibrow import kernel as K

MANIFEST = json.dumps(
    {
        "versions": [
            {
                "version": "900.0.0.1",
                "label": "Chrome 900",
                "platform": "win64",
                "download_url": "fp-chromium-900-win64.zip",
                "exe_rel_path": "chrome.exe",
                "build": "b1",
            },
            {
                "version": "900.0.0.1",
                "label": "Chrome 900",
                "platform": "linuxarm64",
                "download_url": "fp-chromium-900-linuxarm64.zip",
                "exe_rel_path": "chrome",
                "build": "b1",
            },
        ]
    }
)


@pytest.fixture(autouse=True)
def isolated_registry(monkeypatch):
    """Keep discovered versions out of the other test modules."""
    monkeypatch.setattr(K, "_registered", [])


@pytest.fixture
def fetches(monkeypatch):
    """Record manifest fetches instead of hitting the network."""
    calls = []

    def fetch(manifest_url=K.KERNEL_MANIFEST_URL):
        calls.append(manifest_url)
        return K.parse_kernel_manifest(MANIFEST, manifest_url)

    monkeypatch.setattr(K, "fetch_remote_kernel_versions", fetch)
    return calls


def test_registers_manifest_versions_and_caches_them_as_a_bare_list(tmp_path, fetches):
    assert K.refresh_kernel_versions(tmp_path) is True
    assert len(fetches) == 1

    discovered = {kv.version: kv for kv in K.kernels_for_platform("win32")}
    assert "900.0.0.1" in discovered
    assert discovered["900.0.0.1"].asset("win32").build == "b1"

    raw = json.loads((tmp_path / K.KERNEL_VERSION_CACHE_FILE).read_text(encoding="utf-8"))
    assert isinstance(raw, list)  # the Node SDK / desktop cache loader requires a list
    # camelCase asset keys: the file is read by the Node SDK too.
    assert raw[0]["platforms"]["win32"]["downloadUrl"].endswith("fp-chromium-900-win64.zip")
    assert raw[0]["platforms"]["win32"]["exeRelPath"] == "chrome.exe"

    round_tripped = {kv.version: kv for kv in K.load_cached_kernel_versions(tmp_path)}
    assert set(round_tripped["900.0.0.1"].platforms) == {"win32", "linux-arm64"}
    assert round_tripped["900.0.0.1"].asset("linux-arm64").build == "b1"


def test_a_fresh_cache_is_served_without_a_fetch_and_force_overrides_it(tmp_path, fetches):
    K.refresh_kernel_versions(tmp_path)
    assert len(fetches) == 1

    assert K.refresh_kernel_versions(tmp_path) is False  # within TTL
    assert len(fetches) == 1

    assert K.refresh_kernel_versions(tmp_path, force=True) is True
    assert len(fetches) == 2


def test_a_cache_older_than_the_ttl_is_refetched(tmp_path, fetches):
    K.refresh_kernel_versions(tmp_path)
    stale = time.time() - 600
    os.utime(tmp_path / K.KERNEL_VERSION_CACHE_FILE, (stale, stale))

    assert K.refresh_kernel_versions(tmp_path, ttl_seconds=60) is True
    assert len(fetches) == 2


def test_a_failed_fetch_keeps_the_cache_and_never_raises(tmp_path, fetches, monkeypatch):
    K.refresh_kernel_versions(tmp_path)

    def boom(manifest_url=K.KERNEL_MANIFEST_URL):
        raise OSError("offline")

    monkeypatch.setattr(K, "fetch_remote_kernel_versions", boom)
    assert K.refresh_kernel_versions(tmp_path, force=True) is False
    # The cache survived the failed refresh rather than being cleared, and the
    # version it holds is still registered.
    assert [kv.version for kv in K.load_cached_kernel_versions(tmp_path)] == ["900.0.0.1"]
    assert any(kv.version == "900.0.0.1" for kv in K.all_kernel_versions())


def test_an_unreadable_or_foreign_cache_is_ignored(tmp_path):
    cache = tmp_path / K.KERNEL_VERSION_CACHE_FILE
    cache.write_text("not json", encoding="utf-8")
    assert K.load_cached_kernel_versions(tmp_path) == []

    # Rows we cannot use (unknown platform, no URL) are dropped, not fatal.
    cache.write_text(
        json.dumps(
            [
                {"version": "901.0.0.1", "platforms": {"solaris": {"downloadUrl": "x.zip"}}},
                {"version": "902.0.0.1", "platforms": {"win32": {}}},
                "junk",
            ]
        ),
        encoding="utf-8",
    )
    assert K.load_cached_kernel_versions(tmp_path) == []
