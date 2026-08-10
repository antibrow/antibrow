"""Browser kernel catalogue, download and on-disk cache.

Kernels are per-platform zips cached under ``<cache_dir>/kernels/<version>/``.
Versions come from the compiled-in :data:`KERNEL_VERSIONS` baseline (one entry:
what new profiles get) plus a runtime manifest that only *augments* it - remote
entries never rewrite a built-in URL or move the default.
"""

from __future__ import annotations

import json
import os
import platform as _platform
import random
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .config import USER_AGENT
from .errors import KernelDownloadError, UnsupportedPlatformError

ProgressCallback = Callable[[str], None]

#: Only Linux is split by arch: macOS is universal, Windows is x64 only.
SUPPORTED_PLATFORMS = ("win32", "linux", "linux-arm64", "darwin")

#: Manifest platform token -> our platform key.
_MANIFEST_PLATFORM = {
    "win64": "win32",
    "linux64": "linux",
    "linuxarm64": "linux-arm64",
    "mac-universal": "darwin",
}

_ARM64_MACHINES = frozenset({"aarch64", "arm64", "aarch64_be", "armv8b", "armv8l"})


def _is_linux_asset(platform: str) -> bool:
    return platform in ("linux", "linux-arm64")


def _machine() -> str:
    """Patchable in tests."""
    return _platform.machine()


def _default_exe_rel_path(platform: str) -> str:
    """Fallback when a manifest row omits exe_rel_path."""
    if platform == "win32":
        return "chrome.exe"
    if platform == "darwin":
        return "Chromium.app/Contents/MacOS/Chromium"
    return "chrome"


#: Where new kernel builds are announced (same origin as the zips).
KERNEL_MANIFEST_URL = "https://download.antibrow.com/fp-browser-versions.json"

#: Filename of the build marker written inside an installed kernel directory.
BUILD_MARKER = ".fp-build"

_DOWNLOAD_TIMEOUT = 60
_MANIFEST_TIMEOUT = 15


@dataclass
class KernelAsset:
    """One (version x platform) download."""

    download_url: str
    #: Browser executable path relative to the extracted kernel directory.
    exe_rel_path: str
    #: Opaque freshness marker from the manifest, e.g. ``"2026-07-24 07:09"``.
    #: A rebuilt same-version zip keeps the URL but bumps this.
    build: Optional[str] = None


@dataclass
class KernelVersion:
    version: str
    label: str
    #: Only the platforms this version was actually built for.
    platforms: Dict[str, KernelAsset] = field(default_factory=dict)

    def asset(self, platform: Optional[str] = None) -> KernelAsset:
        plat = platform or current_platform()
        asset = self.platforms.get(plat)
        if asset is None:
            raise UnsupportedPlatformError(
                'Kernel {0} has no build for platform "{1}"'.format(self.version, plat)
            )
        return asset

    def available_on(self, platform: Optional[str] = None) -> bool:
        try:
            plat = platform or current_platform()
        except UnsupportedPlatformError:
            return False
        return plat in self.platforms


#: The one version compiled in: what new profiles get. Every other kernel comes
#: from the manifest at runtime, so the default moves only with a release.
KERNEL_VERSIONS: List[KernelVersion] = [
    KernelVersion(
        version="150.0.7871.182",
        label="Chrome 150",
        platforms={
            "win32": KernelAsset(
                "https://download.antibrow.com/fp-chromium-150-win64.zip", "chrome.exe"
            ),
            "linux": KernelAsset(
                "https://download.antibrow.com/fp-chromium-150-linux64.zip", "chrome"
            ),
            "linux-arm64": KernelAsset(
                "https://download.antibrow.com/fp-chromium-150-linuxarm64.zip", "chrome"
            ),
            "darwin": KernelAsset(
                "https://download.antibrow.com/fp-chromium-150-mac-universal.zip",
                "Chromium.app/Contents/MacOS/Chromium",
            ),
        },
    ),
]

#: Versions discovered at runtime from the remote manifest.
_registered: List[KernelVersion] = []


def current_platform() -> str:
    """Map :data:`sys.platform` onto a supported kernel platform."""
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform.startswith("linux"):
        # arm64 needs its own build; x86_64/i686 both take the linux64 asset.
        return "linux-arm64" if _machine().lower() in _ARM64_MACHINES else "linux"
    if sys.platform == "darwin":
        return "darwin"
    raise UnsupportedPlatformError(
        "Unsupported platform: {0}. The kernel ships Windows, Linux and "
        "macOS builds.".format(sys.platform)
    )


def version_sort_key(version: str) -> tuple:
    """Numeric tuple for comparing dotted versions ("150.0.7871.182")."""
    parts = []
    for chunk in version.split("."):
        try:
            parts.append(int(chunk))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def _copy_version(kv: KernelVersion) -> KernelVersion:
    return KernelVersion(
        version=kv.version,
        label=kv.label,
        platforms={k: KernelAsset(v.download_url, v.exe_rel_path, v.build) for k, v in kv.platforms.items()},
    )


def _merge_platforms(target: KernelVersion, incoming: Dict[str, KernelAsset]) -> None:
    for plat, asset in incoming.items():
        existing = target.platforms.get(plat)
        if existing is None:
            # First writer wins for the download asset: baseline beats remote.
            target.platforms[plat] = KernelAsset(asset.download_url, asset.exe_rel_path, asset.build)
            continue
        # `build` is a freshness signal, so the latest seen wins.
        if asset.build and existing.build != asset.build:
            existing.build = asset.build


def all_kernel_versions() -> List[KernelVersion]:
    """Baseline merged with runtime-registered versions, newest first."""
    merged: Dict[str, KernelVersion] = {}
    for kv in list(KERNEL_VERSIONS) + list(_registered):
        existing = merged.get(kv.version)
        if existing is None:
            merged[kv.version] = _copy_version(kv)
        else:
            _merge_platforms(existing, kv.platforms)
    return sorted(merged.values(), key=lambda kv: version_sort_key(kv.version), reverse=True)


def register_kernel_versions(versions: List[KernelVersion]) -> None:
    """Add runtime-discovered versions to the catalogue (idempotent)."""
    for kv in versions:
        if not kv.version or not kv.platforms:
            continue
        existing = next((k for k in _registered if k.version == kv.version), None)
        if existing is None:
            _registered.append(_copy_version(kv))
        else:
            _merge_platforms(existing, kv.platforms)


def parse_kernel_manifest(text: str, manifest_url: str = KERNEL_MANIFEST_URL) -> List[KernelVersion]:
    """Parse ``fp-browser-versions.json`` (one row per version x platform).

    Relative ``download_url`` values resolve against the manifest origin, which
    keeps the manifest CDN-agnostic: the same file works from any mirror.
    """
    payload = json.loads(text.lstrip("﻿"))
    rows = payload.get("versions") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []

    by_version: Dict[str, KernelVersion] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        plat = _MANIFEST_PLATFORM.get(str(row.get("platform", "")))
        version = row.get("version")
        url = row.get("download_url")
        if not plat or not version or not url:
            continue
        if not str(url).lower().startswith(("http://", "https://")):
            url = urllib.parse.urljoin(manifest_url, str(url))
        kv = by_version.get(version)
        if kv is None:
            kv = KernelVersion(version=version, label=row.get("label") or version, platforms={})
            by_version[version] = kv
        if plat not in kv.platforms:
            kv.platforms[plat] = KernelAsset(
                download_url=str(url),
                exe_rel_path=row.get("exe_rel_path") or _default_exe_rel_path(plat),
                build=row.get("build"),
            )
    return list(by_version.values())


def fetch_remote_kernel_versions(manifest_url: str = KERNEL_MANIFEST_URL) -> List[KernelVersion]:
    """Download and parse the remote kernel manifest. Raises on failure."""
    request = urllib.request.Request(
        _cache_bust(manifest_url),
        headers={
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=_MANIFEST_TIMEOUT) as response:  # noqa: S310
        text = response.read().decode("utf-8", "replace")
    return parse_kernel_manifest(text, manifest_url)


def refresh_kernel_catalogue(manifest_url: str = KERNEL_MANIFEST_URL) -> bool:
    """Best-effort manifest refresh. Returns False when offline."""
    try:
        register_kernel_versions(fetch_remote_kernel_versions(manifest_url))
        return True
    except Exception:
        return False


#: Bare list in the Node SDK's shape (camelCase keys): one shared cache dir.
KERNEL_VERSION_CACHE_FILE = "kernel-versions-cache.json"

KERNEL_MANIFEST_TTL_SECONDS = 60 * 60


def _cache_file(cache_dir: Path | str) -> Path:
    return Path(cache_dir) / KERNEL_VERSION_CACHE_FILE


def _version_to_cache_entry(kv: KernelVersion) -> dict:
    return {
        "version": kv.version,
        "label": kv.label,
        "platforms": {
            plat: {
                "downloadUrl": asset.download_url,
                "exeRelPath": asset.exe_rel_path,
                **({"build": asset.build} if asset.build else {}),
            }
            for plat, asset in kv.platforms.items()
        },
    }


def _version_from_cache_entry(row: object) -> Optional[KernelVersion]:
    if not isinstance(row, dict):
        return None
    version = row.get("version")
    platforms = row.get("platforms")
    if not isinstance(version, str) or not isinstance(platforms, dict):
        return None
    assets: Dict[str, KernelAsset] = {}
    for plat, raw in platforms.items():
        if plat not in SUPPORTED_PLATFORMS or not isinstance(raw, dict):
            continue
        url = raw.get("downloadUrl")
        if not isinstance(url, str) or not url:
            continue
        exe = raw.get("exeRelPath")
        assets[plat] = KernelAsset(
            url,
            exe if isinstance(exe, str) and exe else _default_exe_rel_path(plat),
            raw.get("build") if isinstance(raw.get("build"), str) else None,
        )
    if not assets:
        return None
    label = row.get("label")
    return KernelVersion(version, label if isinstance(label, str) else version, assets)


def load_cached_kernel_versions(cache_dir: Path | str) -> List[KernelVersion]:
    """Versions saved by a previous fetch."""
    try:
        rows = json.loads(_cache_file(cache_dir).read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(rows, list):
        return []
    parsed = [_version_from_cache_entry(row) for row in rows]
    return [kv for kv in parsed if kv is not None]


def _write_cached_kernel_versions(cache_dir: Path | str, versions: List[KernelVersion]) -> None:
    try:
        directory = Path(cache_dir)
        directory.mkdir(parents=True, exist_ok=True)
        _cache_file(directory).write_text(
            json.dumps([_version_to_cache_entry(kv) for kv in versions]), encoding="utf-8"
        )
    except OSError:
        pass  # best-effort: a missing cache only costs one fetch next time


def _cached_age_seconds(cache_dir: Path | str) -> float:
    try:
        return max(0.0, time.time() - _cache_file(cache_dir).stat().st_mtime)
    except OSError:
        return float("inf")


def refresh_kernel_versions(
    cache_dir: Path | str,
    force: bool = False,
    ttl_seconds: Optional[float] = None,
    manifest_url: str = KERNEL_MANIFEST_URL,
) -> bool:
    """Register the cached catalogue, then re-fetch once it is older than
    ``ttl_seconds``. Never raises; True only when a fetch actually happened.
    """
    cached = load_cached_kernel_versions(cache_dir)
    if cached:
        register_kernel_versions(cached)

    ttl = KERNEL_MANIFEST_TTL_SECONDS if ttl_seconds is None else ttl_seconds
    if not force and cached and _cached_age_seconds(cache_dir) < ttl:
        return False

    try:
        remote = fetch_remote_kernel_versions(manifest_url)
    except Exception:
        return False  # offline / CDN hiccup: baseline + cache still resolve
    register_kernel_versions(remote)
    _write_cached_kernel_versions(cache_dir, remote)
    return True


def default_kernel_version() -> KernelVersion:
    """Kernel used for brand-new profiles: newest baseline build for this platform."""
    try:
        plat = current_platform()
    except UnsupportedPlatformError:
        return KERNEL_VERSIONS[0]
    for kv in KERNEL_VERSIONS:
        if plat in kv.platforms:
            return kv
    return KERNEL_VERSIONS[0]


def find_kernel_version(version: Optional[str]) -> KernelVersion:
    """Look a version up in the catalogue, falling back to the default."""
    if version:
        for kv in all_kernel_versions():
            if kv.version == version:
                return kv
    return default_kernel_version()


def find_kernel_version_strict(version: str) -> KernelVersion:
    """Look up a version the caller cannot substitute.

    Versions published after this release exist only in the manifest, so an
    offline or stale catalogue would otherwise hand back the compiled-in
    default - a silent downgrade for anything pinned to a specific kernel.
    """
    for kv in all_kernel_versions():
        if kv.version == version:
            return kv
    raise KernelDownloadError(
        "Kernel {0} is not in the catalogue. Refresh the kernel list with an internet "
        "connection and retry; falling back to another version would change this "
        "profile's identity.".format(version)
    )


def kernels_for_platform(platform: Optional[str] = None) -> List[KernelVersion]:
    plat = platform or current_platform()
    return [kv for kv in all_kernel_versions() if plat in kv.platforms]




def kernel_dir(cache_dir: Path | str, version: str) -> Path:
    return Path(cache_dir) / "kernels" / version


def kernel_exe_path(cache_dir: Path | str, kv: KernelVersion, platform: Optional[str] = None) -> Path:
    return kernel_dir(cache_dir, kv.version) / kv.asset(platform).exe_rel_path


def is_kernel_installed(cache_dir: Path | str, kv: KernelVersion, platform: Optional[str] = None) -> bool:
    if not kv.available_on(platform):
        return False
    return kernel_exe_path(cache_dir, kv, platform).exists()


def list_installed_kernels(cache_dir: Path | str, platform: Optional[str] = None) -> List[str]:
    return [kv.version for kv in all_kernel_versions() if is_kernel_installed(cache_dir, kv, platform)]


def kernel_dir_size(cache_dir: Path | str, version: str) -> int:
    """Total bytes on disk for an installed kernel (0 when absent)."""
    root = kernel_dir(cache_dir, version)
    total = 0
    if not root.exists():
        return 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def delete_kernel(cache_dir: Path | str, version: str) -> None:
    """Remove an installed kernel directory. Idempotent."""
    shutil.rmtree(kernel_dir(cache_dir, version), ignore_errors=True)


def installed_kernel_build(cache_dir: Path | str, version: str) -> Optional[str]:
    """Build recorded when this kernel was installed, or None when unknown.

    Unknown means "installed by an older SDK / without manifest metadata" and
    should be treated as up to date rather than nagged about.
    """
    try:
        value = (kernel_dir(cache_dir, version) / BUILD_MARKER).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def write_installed_kernel_build(cache_dir: Path | str, version: str, build: str) -> None:
    """Record the build id of an installed kernel (best effort)."""
    try:
        directory = kernel_dir(cache_dir, version)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / BUILD_MARKER).write_text(build, encoding="utf-8")
    except OSError:
        pass


#: First kernel version built with the mobile device patches.
ANDROID_MIN_KERNEL_VERSION = "151.0.7922.72"
#: Build stamp of the first kernel carrying the mobile device patches.
ANDROID_MIN_KERNEL_BUILD = "2026-08-07 05:17"


def _version_tuple(version: str) -> tuple:
    parts = []
    for piece in version.split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def kernel_version_at_least(version: Optional[str], minimum: str) -> bool:
    """True when ``version`` is at or above ``minimum``, segment by segment."""
    if not version:
        return False
    a = _version_tuple(version)
    b = _version_tuple(minimum)
    length = max(len(a), len(b))
    a = a + (0,) * (length - len(a))
    b = b + (0,) * (length - len(b))
    return a >= b


def kernel_supports_android(version: Optional[str], build: Optional[str]) -> bool:
    """Both halves are load-bearing.

    The version alone cannot answer it: the same version shipped twice, once
    before the mobile patches and once after. The build date alone cannot
    either: every kernel version gets rebuilt on the same day when the whole
    set is republished, so a date-only rule lets a kernel with none of the
    mobile patches through. An older binary handed an Android config produces a
    profile whose UA says Android while its client hints say desktop - worse
    than no Android at all.
    """
    if not kernel_version_at_least(version, ANDROID_MIN_KERNEL_VERSION):
        return False
    if not build or len(build) < 10:
        return False
    date = build[:10]
    if len(date) != 10 or date[4] != "-" or date[7] != "-":
        return False
    if not (date[:4].isdigit() and date[5:7].isdigit() and date[8:10].isdigit()):
        return False
    return date >= ANDROID_MIN_KERNEL_BUILD[:10]


@dataclass
class KernelUpdateStatus:
    version: str
    label: str
    installed: bool
    installed_build: Optional[str] = None
    available_build: Optional[str] = None
    update_available: bool = False


def kernel_update_status(
    cache_dir: Path | str, version: str, platform: Optional[str] = None
) -> Optional[KernelUpdateStatus]:
    """Update status of one installed kernel, or None when it isn't installed.

    This comparison is offline: it is only meaningful after
    :func:`refresh_kernel_catalogue` has merged the published builds, because
    the compiled-in baseline carries no ``build`` at all.
    """
    plat = platform or current_platform()
    kv = find_kernel_version(version)
    if not is_kernel_installed(cache_dir, kv, plat):
        return None
    available = kv.platforms[plat].build if plat in kv.platforms else None
    have = installed_kernel_build(cache_dir, kv.version)
    if have is None:
        # No marker: adopt the current build rather than report an
        # unverifiable drift.
        if available:
            write_installed_kernel_build(cache_dir, kv.version, available)
        return KernelUpdateStatus(kv.version, kv.label, True, available, available, False)
    return KernelUpdateStatus(
        kv.version, kv.label, True, have, available, bool(available and have != available)
    )


def installed_kernel_updates(
    cache_dir: Path | str, platform: Optional[str] = None
) -> List[KernelUpdateStatus]:
    plat = platform or current_platform()
    out = []
    for kv in kernels_for_platform(plat):
        status = kernel_update_status(cache_dir, kv.version, plat)
        if status is not None:
            out.append(status)
    return out


def _cache_bust(url: str) -> str:
    """Append a random query param so a CDN edge can't serve a stale zip.

    Kernels are published under a fixed filename per major version, so a rebuild
    reuses the URL. The local cache is separate: ``ensure_kernel`` skips the
    download entirely when the directory already exists.
    """
    sep = "&" if "?" in url else "?"
    token = "{0:x}{1}".format(int(time.time() * 1000), random.randint(0x100000, 0xFFFFFF))
    return "{0}{1}_cb={2}".format(url, sep, token)


def _download(url: str, dest: Path, on_progress: Optional[ProgressCallback] = None) -> None:
    request = urllib.request.Request(
        url,
        headers={"Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": USER_AGENT},
    )
    last_report = -1
    try:
        with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT) as response:  # noqa: S310
            status = getattr(response, "status", 200) or 200
            if status >= 400:
                raise KernelDownloadError("Download failed: HTTP {0} from {1}".format(status, url))
            total = int(response.headers.get("Content-Length") or 0)
            downloaded = 0
            with open(dest, "wb") as handle:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    downloaded += len(chunk)
                    if total > 0 and on_progress is not None:
                        percent = int(downloaded * 100 / total)
                        if percent != last_report:
                            last_report = percent
                            on_progress("Downloading {0}%".format(percent))
    except urllib.error.HTTPError as exc:
        raise KernelDownloadError("Download failed: HTTP {0} from {1}".format(exc.code, url)) from exc
    except urllib.error.URLError as exc:
        raise KernelDownloadError("Download failed: {0} ({1})".format(exc.reason, url)) from exc


def _extract_zip(zip_path: Path, dest_dir: Path, on_progress: Optional[ProgressCallback] = None) -> int:
    """Extract a kernel zip, preserving unix permission bits when present.

    macOS goes through ``ditto`` instead: the mac kernel is a .app bundle whose
    framework directories are symlinks, and it is published with ``ditto -c -k``.
    :mod:`zipfile` writes those entries out as regular files holding the target
    path, which breaks the bundle's code signature -- the app then dies on launch
    with no usable error. ``ditto -x -k`` is the exact inverse of how it was
    packed, so symlinks, permission bits and xattrs survive.
    """
    if sys.platform == "darwin":
        return _extract_zip_with_ditto(zip_path, dest_dir, on_progress)

    count = 0
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            # ZipFile.extract() sanitizes paths, so entries cannot escape.
            archive.extract(info, dest_dir)
            if info.is_dir():
                continue
            count += 1
            mode = info.external_attr >> 16
            if mode:
                try:
                    os.chmod(dest_dir / info.filename, stat.S_IMODE(mode))
                except OSError:
                    pass
            if on_progress is not None and count % 200 == 0:
                on_progress("Extracting {0} files...".format(count))
    if on_progress is not None:
        on_progress("Extracted {0} files".format(count))
    return count


def _extract_zip_with_ditto(
    zip_path: Path, dest_dir: Path, on_progress: Optional[ProgressCallback] = None
) -> int:
    # No "Extracting kernel" message here: ensure_kernel already emits it right
    # before calling us, and ditto gives no incremental progress to report.
    proc = subprocess.run(
        ["/usr/bin/ditto", "-x", "-k", str(zip_path), str(dest_dir)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or "ditto exited {0}".format(proc.returncode)
        raise KernelDownloadError("Failed to extract the kernel with ditto: {0}".format(detail))
    count = sum(1 for p in dest_dir.rglob("*") if p.is_file())
    if on_progress is not None:
        on_progress("Extracted {0} files".format(count))
    return count


def verify_darwin_bundle_signature(app_path: Path) -> None:
    """Verify an extracted .app bundle still satisfies its own code signature.

    Worth the extra seconds on a fresh download: a bundle whose seal is broken is
    killed by the OS at launch with no diagnosable error, so failing loudly here --
    while we still know a download just happened -- is the difference between
    "re-download the kernel" and an unexplained crash.
    """
    proc = subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        return
    detail = (proc.stderr or proc.stdout).strip() or "codesign exited {0}".format(proc.returncode)
    raise KernelDownloadError(
        "Kernel signature verification failed for {0}: {1}. "
        "The download is corrupt -- delete the kernel and try again.".format(app_path, detail)
    )


def chmod_kernel_binaries(directory: Path) -> None:
    """Give every extension-less file in the kernel dir +x (Linux).

    ``chrome_crashpad_handler`` and friends abort the browser with a posix_spawn
    EPERM / SIGABRT when they are not executable, and zip extraction on some
    toolchains drops the bits.
    """
    try:
        entries = list(Path(directory).iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.is_file() and entry.suffix == "":
            try:
                entry.chmod(0o755)
            except OSError:
                pass


def ensure_kernel(
    cache_dir: Path | str,
    kv: Optional[KernelVersion] = None,
    on_progress: Optional[ProgressCallback] = None,
    *,
    force: bool = False,
    platform: Optional[str] = None,
) -> Path:
    """Make sure a kernel is downloaded and extracted; return the exe path.

    Idempotent: an already-installed kernel is a no-op (aside from re-applying
    +x on Linux). ``force=True`` re-downloads, which is how a rebuilt
    same-version kernel is picked up.
    """
    cache = Path(cache_dir)
    version = kv or default_kernel_version()
    plat = platform or current_platform()
    asset = version.asset(plat)
    target_dir = kernel_dir(cache, version.version)
    exe_path = target_dir / asset.exe_rel_path

    if not force and exe_path.exists():
        if _is_linux_asset(plat):
            chmod_kernel_binaries(exe_path.parent)
        return exe_path

    if on_progress is not None:
        on_progress("Downloading kernel {0} ({1})".format(version.label, plat))

    cache.mkdir(parents=True, exist_ok=True)
    zip_path = cache / "kernel-{0}-{1}.zip".format(version.version, plat)
    try:
        # Extract in place: on Windows a rename fails with EPERM while
        # antivirus holds the fresh binaries.
        shutil.rmtree(target_dir, ignore_errors=True)
        target_dir.mkdir(parents=True, exist_ok=True)

        _download(_cache_bust(asset.download_url), zip_path, on_progress)
        if on_progress is not None:
            on_progress("Extracting kernel")
        _extract_zip(zip_path, target_dir, on_progress)

        if not exe_path.exists():
            raise KernelDownloadError(
                'Kernel downloaded but "{0}" is missing after extraction. This usually '
                "means antivirus/Windows Defender quarantined the kernel - add an "
                'exclusion for "{1}" (and your temp folder) and try again.'.format(
                    asset.exe_rel_path, target_dir
                )
            )

        # The mac kernel is a signed .app; a broken seal here means the extraction
        # mangled the bundle. Catch it now, not at launch.
        if plat == "darwin":
            if on_progress is not None:
                on_progress("Verifying kernel signature")
            verify_darwin_bundle_signature(target_dir / asset.exe_rel_path.split("/")[0])

        if _is_linux_asset(plat):
            chmod_kernel_binaries(exe_path.parent)
        if asset.build:
            write_installed_kernel_build(cache, version.version, asset.build)
    except BaseException:
        # Never leave a half-installed directory behind.
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    finally:
        try:
            zip_path.unlink()
        except OSError:
            pass

    if on_progress is not None:
        on_progress("Kernel ready: {0}".format(version.version))
    return exe_path
