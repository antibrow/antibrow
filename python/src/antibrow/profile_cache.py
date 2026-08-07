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
from typing import Optional, Set, Tuple

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

#: Which generation of the cloud archive this machine holds. Machine-local: not
#: in ROOT_ITEMS so it is never packed, and an import clears it because the
#: generation of imported state is unknowable.
ARCHIVE_VERSION_FILE = ".archive-version"


def read_archive_version(profile_dir: Path | str) -> Optional[str]:
    try:
        return (Path(profile_dir) / ARCHIVE_VERSION_FILE).read_text("utf8").strip() or None
    except (OSError, ValueError):
        # ValueError covers UnicodeDecodeError on a corrupt marker: the JS SDK's
        # readFileSync degrades a bad-UTF8 file to replacement characters (a
        # marker mismatch, so it just re-downloads); this must be equally
        # non-fatal here rather than failing the launch.
        return None


def write_archive_version(profile_dir: Path | str, version: str) -> None:
    try:
        root = Path(profile_dir)
        root.mkdir(parents=True, exist_ok=True)
        (root / ARCHIVE_VERSION_FILE).write_text(version, "utf8")
    except OSError:
        pass  # a lost marker only costs one redundant download


def clear_archive_version(profile_dir: Path | str) -> None:
    try:
        (Path(profile_dir) / ARCHIVE_VERSION_FILE).unlink()
    except OSError:
        pass


def normalize_archive_version(etag: Optional[str]) -> Optional[str]:
    """R2 hands back the ETag quoted; the marker stores it bare."""
    return (etag or "").strip().strip('"') or None


#: Lock files that are always in use while the browser runs.
SKIP_FILES: Set[str] = {"LOCK", "lock", ".lock", "SingletonLock", "SingletonCookie", "SingletonSocket"}

#: Device-bound session records. Their private keys live in the OS keystore
#: (Secure Enclave / TPM) and cannot be exported, so carrying the records to
#: another machine only makes the site refuse the session outright.
DBSC_FILES: Set[str] = {"Device Bound Sessions", "Device Bound Sessions-journal"}

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
        if name in SKIP_FILES or name in DBSC_FILES:
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


def _clear_dir(abs_dir: Path) -> bool:
    """Delete a directory's packable contents, keeping only what a pack skips.

    Returns True when nothing was kept, so the caller can drop the dir too.
    """
    try:
        names = sorted(os.listdir(abs_dir))
    except OSError:
        return False
    kept = 0
    for name in names:
        abs_path = abs_dir / name
        if name in SKIP_FILES:
            kept += 1
            continue
        if abs_path.is_dir():
            if name in SKIP_DIRS:
                kept += 1
                continue
            if _clear_dir(abs_path):
                try:
                    abs_path.rmdir()
                except OSError:
                    kept += 1
            else:
                kept += 1
            continue
        try:
            abs_path.unlink()
        except OSError:
            kept += 1
    return kept == 0


def _packed_items(names: "list[str]") -> Set[str]:
    """Which top-level USER_DATA_ITEMS a zip's entries actually carry.

    An item the archive is silent about was never packed in the first place -
    a live browser can hold ``Local State`` open, ``_add_dir``/``zf.writestr``
    swallow the read error, and the resulting archive uploads fine with that
    item simply missing. Clearing it anyway would delete the local copy and put
    nothing back: for ``Local State`` that is ``os_crypt.encrypted_key``, so
    every cookie and saved password in the profile becomes undecryptable.
    """
    present: Set[str] = set()
    for name in names:
        clean = name.replace("\\", "/")
        if not clean.startswith("user-data/"):
            continue
        rest = clean[len("user-data/"):]
        item = rest.split("/")[0]
        if item:
            present.add(item)
    return present


def _clear_packed_state(root: Path, present: Set[str]) -> None:
    """Wipe everything a pack would have carried, so a restore replaces the
    profile's state instead of merging into it.

    Leftovers are not inert: the browser picks the session to restore by the
    timestamp in the file name, so a local ``Sessions/Session_<newer>`` silently
    outranks the restored one and the profile opens with the wrong machine's
    tabs. Same for leveldb and the SQLite -wal/-journal siblings of a database
    the archive replaced.

    ROOT_ITEMS are left alone on purpose: they are standalone JSON, and an
    archive written before they were synced must not delete them -- persona.json
    IS the profile's identity, and losing it means a different fingerprint.
    """
    user_data = root / "user-data"
    for item in USER_DATA_ITEMS:
        if item not in present:
            continue
        path = user_data / item
        if not path.exists():
            continue
        if path.is_dir():
            _clear_dir(path)
        else:
            try:
                path.unlink()
            except OSError:
                pass


def unpack_profile_cache(data: bytes, profile_dir: Path | str) -> None:
    """Replace the profile's synced state with the archive's."""
    root = Path(profile_dir)
    # Open before deleting anything: a truncated download must leave the profile
    # as it was, not half-erased.
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        root.mkdir(parents=True, exist_ok=True)
        _clear_packed_state(root, _packed_items(zf.namelist()))
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


def upload_profile_cache(profile_dir: Path | str, put_url: str) -> Optional[str]:
    """Pack the profile cache and PUT it to a presigned URL.

    Returns the new generation (the object's ETag), or None when R2 did not
    name one.
    """
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
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as response:  # noqa: S310
            return normalize_archive_version(response.headers.get("ETag"))
    except urllib.error.HTTPError as error:
        raise ProfileCacheError("Failed to upload profile cache: HTTP {0}".format(error.code))
    except urllib.error.URLError as error:
        raise ProfileCacheError("Failed to upload profile cache: {0}".format(error.reason))
