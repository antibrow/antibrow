"""The profile cache that travels between machines.

A zip of the parts of a profile directory that carry identity and browser
state, uploaded to the presigned URL the server hands out per profile. The
layout matches the Node SDK byte for byte, so the same profile can be opened
from either SDK or from the desktop app.
"""

from __future__ import annotations

import io
import os
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Set, Tuple

from .config import USER_AGENT
from .errors import ProfileCacheError

#: Browser state kept under ``<profile_dir>/user-data/``.
USER_DATA_ITEMS: Tuple[str, ...] = ("Default", "GrShaderCache", "Local State", "Variations")

#: The kernel's portable passkey store (``--fp-webauthn-store``), which lives at
#: the profile root rather than inside user-data.
PASSKEYS_ENTRY = "passkeys.json"

#: Items at the profile root. The passkey store belongs here or a passkey
#: registered on one machine never reaches the next one.
ROOT_ITEMS: Tuple[str, ...] = ("persona.json", PASSKEYS_ENTRY)

#: Lock files that are always in use while the browser runs.
SKIP_FILES: Set[str] = {"LOCK", "lock", ".lock", "SingletonLock", "SingletonCookie", "SingletonSocket"}

#: Disposable cache dirs: big, often locked, and rebuilt by the browser anyway.
SKIP_DIRS: Set[str] = {
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "Service Worker",
    "blob_storage",
    "Application Cache",
    "File System",
    "GCM Store",
    "optimization_guide_model_store",
    "component_crx_cache",
    "extensions_crx_cache",
    "Crashpad",
    "segmentation_platform",
}

_REQUEST_TIMEOUT = 120.0


def _add_dir(zf: zipfile.ZipFile, abs_dir: Path, zip_base: str) -> None:
    """Add a directory tree, skipping caches and anything unreadable."""
    try:
        names = sorted(os.listdir(abs_dir))
    except OSError:
        return
    for name in names:
        if name in SKIP_FILES:
            continue
        abs_path = abs_dir / name
        zip_path = "{0}/{1}".format(zip_base, name) if zip_base else name
        if abs_path.is_dir():
            if name in SKIP_DIRS:
                continue
            _add_dir(zf, abs_path, zip_path)
        elif abs_path.is_file():
            try:
                zf.writestr(zip_path, abs_path.read_bytes())
            except OSError:
                pass  # locked or unreadable: never fatal


def pack_profile_cache(profile_dir: Path | str) -> bytes:
    """Zip the profile's synced items. Locked files are skipped, never fatal."""
    root = Path(profile_dir)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in ROOT_ITEMS:
            path = root / item
            try:
                if path.is_file():
                    zf.writestr(item, path.read_bytes())
            except OSError:
                pass

        user_data = root / "user-data"
        for item in USER_DATA_ITEMS:
            path = user_data / item
            if not path.exists():
                continue
            if path.is_dir():
                _add_dir(zf, path, "user-data/{0}".format(item))
            else:
                try:
                    zf.writestr("user-data/{0}".format(item), path.read_bytes())
                except OSError:
                    pass
    return buf.getvalue()


def _safe_join(root: Path, entry_name: str) -> "Path | None":
    """Resolve a zip entry under ``root``, or None when it escapes (zip slip)."""
    base = root.resolve()
    dest = (base / entry_name).resolve()
    return dest if base == dest or base in dest.parents else None


def unpack_profile_cache(data: bytes, profile_dir: Path | str) -> None:
    """Extract a cache zip into the profile directory."""
    root = Path(profile_dir)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            dest = _safe_join(root, info.filename.replace("\\", "/"))
            if dest is None:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(info))


def download_profile_cache(get_url: str, profile_dir: Path | str) -> bool:
    """Fetch the cache from a presigned GET URL and unpack it.

    Returns False when the profile has no archive yet (the server answers 404,
    R2 answers 403 for a missing object) - a first launch, not an error.
    """
    request = urllib.request.Request(get_url, method="GET", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as response:  # noqa: S310
            data = response.read()
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return False
        raise ProfileCacheError("Failed to download profile cache: HTTP {0}".format(error.code))
    except urllib.error.URLError as error:
        raise ProfileCacheError("Failed to download profile cache: {0}".format(error.reason))

    if not data:
        return False
    try:
        unpack_profile_cache(data, profile_dir)
    except zipfile.BadZipFile:
        raise ProfileCacheError("Downloaded profile cache is not a valid archive")
    return True


def upload_profile_cache(profile_dir: Path | str, put_url: str) -> int:
    """Pack the profile cache and PUT it to a presigned URL. Returns the size."""
    payload = pack_profile_cache(profile_dir)
    request = urllib.request.Request(
        put_url,
        data=payload,
        method="PUT",
        headers={
            "Content-Type": "application/zip",
            "Content-Length": str(len(payload)),
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT):  # noqa: S310
            return len(payload)
    except urllib.error.HTTPError as error:
        raise ProfileCacheError("Failed to upload profile cache: HTTP {0}".format(error.code))
    except urllib.error.URLError as error:
        raise ProfileCacheError("Failed to upload profile cache: {0}".format(error.reason))
