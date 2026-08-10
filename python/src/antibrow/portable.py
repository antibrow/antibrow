"""Portable profile archives (``.fpprofile``).

The interchange format for moving a profile between machines and between the
tools that speak it: identity in ``manifest.json``, the passkey store next to it,
and a whitelist of real browser state under ``user-data/``. Caches are left out.

``manifest.profile`` is the shared snake_case schema; anything app-specific rides
in a top-level ``antibrow`` key that other readers ignore, just as this reader
ignores keys it does not know.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from dataclasses import dataclass
from dataclasses import fields as _dataclass_fields
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from . import kernel as _kernel
from .errors import ProfileCacheError
from .persona import (
    CapturedFacts,
    Persona,
    chrome_major_of,
    generate_persona,
    read_persona,
    write_persona,
)
from .profile_cache import PASSKEYS_ENTRY, SKIP_DIRS, SKIP_FILES, clear_archive_version

#: Recommended file extension for a portable profile archive.
PROFILE_ARCHIVE_EXT = "fpprofile"

MANIFEST_ENTRY = "manifest.json"
FORMAT_ID = "fp-launcher-profile"
# Desktop profiles stay at 1 so older readers keep importing them. An Android
# profile bumps to 2 because those readers would silently drop its device type
# and launch it as a desktop identity - a loud "upgrade your app" beats one
# profile quietly meaning two different things in two places.
FORMAT_VERSION = 2
FORMAT_VERSION_DESKTOP = 1

#: Metadata entry of the older ``.zip`` export, still importable.
LEGACY_META_ENTRY = "profile.json"

#: The ``user-data/`` files a portable export carries: real browser state only,
#: no caches. A SQLite main file drags its -wal/-shm/-journal siblings along.
PORTABLE_USER_DATA: Sequence[str] = (
    "Local State",
    "Default/Preferences",
    "Default/Secure Preferences",
    "Default/Bookmarks",
    "Default/Favicons",
    "Default/History",
    "Default/Web Data",
    "Default/Login Data",
    "Default/Cookies",
    "Default/Network/Cookies",
    "Default/Network/Trust Tokens",
    "Default/Network/TransportSecurity",
    "Default/Network/Network Persistent State",
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
    "Default/Local Extension Settings",
    # Session restore: without these the import opens with no tabs.
    "Default/Sessions",
    "Default/Current Session",
    "Default/Current Tabs",
    "Default/Last Session",
    "Default/Last Tabs",
)

SQLITE_SIDES = ("-journal", "-wal", "-shm")

#: Persona fields, snake_case in the manifest and snake_case here too, so the
#: mapping is only about which subset travels (kernel_version lives one level up).
_PERSONA_FIELDS = (
    "seed",
    "canvas_seed",
    "audio_seed",
    "domrect_seed",
    "chrome_major",
    "ua",
    "hardware_concurrency",
    "device_memory",
    "screen_w",
    "screen_h",
    "device_pixel_ratio",
    "gpu_vendor",
    "gpu_renderer",
    "languages",
    "timezone",
)


@dataclass
class PortableProfileMeta:
    """What an archive records about a profile besides its identity."""

    name: str
    #: Source profile id, kept for provenance. Defaults to the directory name.
    id: Optional[str] = None
    kernel_version: Optional[str] = None
    #: Proxy as a single URL.
    proxy_url: Optional[str] = None
    api_log: str = "off"
    canvas_noise: bool = True
    webauthn_capture: bool = True
    #: Device profile. On export it is the caller's own record of what this
    #: profile is, checked against the persona on disk; on import it is what the
    #: persona says, so the caller's row can be built to match.
    device_type: Optional[str] = None
    #: Whether the identity came from the captured-machine library.
    real_fingerprint: Optional[bool] = None
    #: App-specific extras. Other readers ignore them.
    extra: Optional[Dict[str, Any]] = None


@dataclass
class ImportedProfileMeta(PortableProfileMeta):
    """:class:`PortableProfileMeta` plus which format it was read from."""

    source: str = "launcher"  # "launcher" | "legacy"


def _captured_to_manifest(cap: CapturedFacts) -> Dict[str, Any]:
    """``CapturedFacts`` attributes are already the launcher's snake_case keys."""
    return {
        f.name: getattr(cap, f.name)
        for f in _dataclass_fields(cap)
        if getattr(cap, f.name) is not None
    }


def _manifest_to_captured(raw: Dict[str, Any]) -> CapturedFacts:
    names = {f.name for f in _dataclass_fields(CapturedFacts)}
    return CapturedFacts(**{key: value for key, value in raw.items() if key in names})


def _persona_to_manifest(persona: Persona) -> Dict[str, Any]:
    out: Dict[str, Any] = {field_name: getattr(persona, field_name) for field_name in _PERSONA_FIELDS}
    if persona.captured_webgl:
        out["captured_webgl"] = persona.captured_webgl
    if persona.device_type:
        out["device_type"] = persona.device_type
    if persona.android_model:
        out["android_model"] = persona.android_model
    if persona.android_os_major is not None:
        out["android_os_major"] = persona.android_os_major
    if persona.captured is not None:
        out["captured"] = _captured_to_manifest(persona.captured)
    return out


def _add_file(zf: zipfile.ZipFile, user_data: Path, abs_path: Path) -> None:
    try:
        if not abs_path.is_file():
            return
        rel = abs_path.relative_to(user_data).as_posix()
        zf.writestr("user-data/{0}".format(rel), abs_path.read_bytes())
    except (OSError, ValueError):
        pass  # missing or locked: best-effort


def _add_dir(zf: zipfile.ZipFile, abs_dir: Path, zip_base: str) -> None:
    try:
        names = sorted(p.name for p in abs_dir.iterdir())
    except OSError:
        return
    for name in names:
        if name in SKIP_FILES:
            continue
        path = abs_dir / name
        zip_path = "{0}/{1}".format(zip_base, name)
        if path.is_dir():
            if name in SKIP_DIRS:
                continue
            _add_dir(zf, path, zip_path)
        elif path.is_file():
            try:
                zf.writestr(zip_path, path.read_bytes())
            except OSError:
                pass


def export_profile_archive(profile_dir: Path | str, meta: PortableProfileMeta) -> bytes:
    """Build a portable ``.fpprofile``.

    Export with the browser closed: a live browser holds SQLite mid-write, and a
    torn copy loses cookies and tabs on import.
    """
    root = Path(profile_dir)
    # Export must not create the identity it exports. An Android or
    # captured-machine profile deliberately has no persona until its first
    # launch, and generating one here would both freeze a plain desktop identity
    # onto it forever and stamp the archive as a desktop profile.
    persona = read_persona(root)
    if persona is None:
        raise ProfileCacheError(
            "This profile has no identity yet - open it once, then export. Its fingerprint "
            "is resolved at first launch, and exporting now would create a different one."
        )
    # A caller that tracks the device type separately must agree with the
    # persona: whichever of the two is wrong, the export carries the
    # disagreement to another machine and one kernel edit there destroys it.
    if meta.device_type and meta.device_type != (persona.device_type or "desktop"):
        raise ProfileCacheError(
            "This profile is recorded as {0!r} but its identity is {1!r}. Exporting would "
            "carry the mismatch forward.".format(meta.device_type, persona.device_type or "desktop")
        )
    # `real_fingerprint` has no home in the interchange schema (the identity
    # itself travels as the persona's captured facts), so it rides in our own
    # extras block.
    extra: Dict[str, Any] = dict(meta.extra or {})
    if meta.real_fingerprint:
        extra["realFingerprint"] = True
    manifest: Dict[str, Any] = {
        "format": FORMAT_ID,
        "version": FORMAT_VERSION if persona.device_type == "android" else FORMAT_VERSION_DESKTOP,
        "profile": {
            "id": meta.id or root.name,
            "name": meta.name,
            "proxy": {"raw": meta.proxy_url or ""},
            "kernel_version": meta.kernel_version or persona.kernel_version,
            "persona": _persona_to_manifest(persona),
            "api_log": meta.api_log,
            "canvas_noise": meta.canvas_noise,
            "webauthn_capture": meta.webauthn_capture,
        },
    }
    if extra:
        manifest["antibrow"] = extra

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_ENTRY, json.dumps(manifest, indent=2))

        passkeys = root / PASSKEYS_ENTRY
        try:
            if passkeys.is_file():
                zf.writestr(PASSKEYS_ENTRY, passkeys.read_bytes())
        except OSError:
            pass

        user_data = root / "user-data"
        for rel in PORTABLE_USER_DATA:
            source = user_data / rel
            if source.is_dir():
                _add_dir(zf, source, "user-data/{0}".format(rel))
            elif source.is_file():
                _add_file(zf, user_data, source)
                for side in SQLITE_SIDES:
                    _add_file(zf, user_data, source.parent / (source.name + side))
    return buf.getvalue()


def import_profile_archive(data: bytes, profile_dir: Path | str) -> ImportedProfileMeta:
    """Restore a portable archive and return its metadata.

    Reads ``.fpprofile`` and the older ``.zip``; neither metadata entry is left
    behind in the profile directory.
    """
    root = Path(profile_dir)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ProfileCacheError("Unreadable profile archive: not a zip file")

    with zf:
        names = set(zf.namelist())
        if MANIFEST_ENTRY in names and LEGACY_META_ENTRY not in names:
            return _import_manifest_archive(zf, _parse_manifest(zf.read(MANIFEST_ENTRY)), root)
        return _import_legacy_archive(zf, root)


def _import_manifest_archive(
    zf: zipfile.ZipFile, manifest: Dict[str, Any], root: Path
) -> ImportedProfileMeta:
    entry = manifest.get("profile") or {}
    # Resolved before anything is written: an Android pin that cannot be
    # honoured here must fail with the target directory still untouched.
    manifest_persona = entry.get("persona") or {}
    android = isinstance(manifest_persona, dict) and manifest_persona.get("device_type") == "android"
    kernel_version = _resolve_kernel_version(
        entry.get("kernel_version") or _default_version(), android
    )
    root.mkdir(parents=True, exist_ok=True)

    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        if name != PASSKEYS_ENTRY and not name.startswith("user-data/"):
            continue
        dest = _safe_join(root, name)
        if dest is None:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(zf.read(info))

    persona = _manifest_to_persona(manifest_persona, kernel_version)
    write_persona(root, persona)
    # The generation this machine held belonged to whatever profile used to live
    # here; an imported archive's generation is unknowable, so the next launch
    # must restore rather than trust a stale marker.
    clear_archive_version(root)

    proxy = entry.get("proxy") or {}
    raw = proxy.get("raw") if isinstance(proxy, dict) else None
    extra = manifest.get("antibrow") if isinstance(manifest.get("antibrow"), dict) else None
    return ImportedProfileMeta(
        source="launcher",
        id=entry.get("id"),
        name=entry.get("name") or "",
        kernel_version=kernel_version,
        proxy_url=(raw.strip() or None) if isinstance(raw, str) else None,
        api_log=_as_api_log_mode(entry.get("api_log")),
        canvas_noise=entry.get("canvas_noise") is not False,
        webauthn_capture=entry.get("webauthn_capture") is not False,
        # The persona is authoritative for both: an importer that drops them
        # ends up with a row saying "desktop" on top of an Android identity.
        device_type=persona.device_type,
        real_fingerprint=True if (extra or {}).get("realFingerprint") is True else None,
        extra=extra,
    )


def _import_legacy_archive(zf: zipfile.ZipFile, root: Path) -> ImportedProfileMeta:
    legacy: Dict[str, Any] = {}
    if LEGACY_META_ENTRY in zf.namelist():
        try:
            decoded = json.loads(zf.read(LEGACY_META_ENTRY).decode("utf-8", "replace"))
            legacy = decoded if isinstance(decoded, dict) else {}
        except ValueError:
            legacy = {}

    root.mkdir(parents=True, exist_ok=True)
    for info in zf.infolist():
        if info.is_dir() or info.filename == LEGACY_META_ENTRY:
            continue
        dest = _safe_join(root, info.filename.replace("\\", "/"))
        if dest is None:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(zf.read(info))
    clear_archive_version(root)

    rest = {key: value for key, value in legacy.items() if key not in ("name", "kernelVersion")}
    version = legacy.get("kernelVersion")
    return ImportedProfileMeta(
        source="legacy",
        name=legacy.get("name") if isinstance(legacy.get("name"), str) else "",
        kernel_version=version if isinstance(version, str) else None,
        extra=rest or None,
    )


def _parse_manifest(raw: bytes) -> Dict[str, Any]:
    try:
        # A BOM from an editor-written manifest would otherwise break the parse.
        manifest = json.loads(raw.decode("utf-8-sig", "replace"))
    except ValueError:
        raise ProfileCacheError("Unreadable profile archive: manifest.json is not valid JSON")
    if not isinstance(manifest, dict):
        raise ProfileCacheError("Unreadable profile archive: manifest.json is not an object")
    if manifest.get("format") != FORMAT_ID:
        raise ProfileCacheError(
            "Unsupported profile archive format: {0}".format(manifest.get("format") or "unknown")
        )
    if int(manifest.get("version") or 1) > FORMAT_VERSION:
        raise ProfileCacheError(
            "This profile was exported by a newer release (format v{0}); update to import it".format(
                manifest.get("version")
            )
        )
    return manifest


def _safe_join(root: Path, entry_name: str) -> Optional[Path]:
    """Resolve a zip entry under ``root``, or None when it escapes (zip slip)."""
    base = root.resolve()
    dest = (base / entry_name).resolve()
    return dest if base == dest or base in dest.parents else None


def _default_version() -> str:
    return _kernel.default_kernel_version().version


def _as_api_log_mode(value: Any) -> str:
    return value if value in ("curated", "all") else "off"


def _resolve_kernel_version(wanted: str, android: bool = False) -> str:
    """The kernel an imported profile can actually launch here.

    The exact version, else the newest known build of the same Chrome major, else
    the default - an archive from another machine must not be unlaunchable.

    An Android profile gets none of that latitude. Its version is a pin, not a
    preference, and rewriting it to a kernel without the mobile patches would
    turn the import into a profile that claims to be a phone and cannot behave
    like one.
    """
    try:
        known: List[str] = [kv.version for kv in _kernel.kernels_for_platform()]
    except Exception:
        known = []
    if wanted in known:
        return wanted
    if android:
        raise ProfileCacheError(
            "This Android profile needs kernel {0}, which is not in the catalogue here. "
            "Refresh the kernel list with an internet connection and import again.".format(wanted)
        )
    major = wanted.split(".")[0]
    for version in known:
        if version.split(".")[0] == major:
            return version
    return _default_version()


def _manifest_to_persona(entry: Dict[str, Any], kernel_version: str) -> Persona:
    """Keep every seed and hardware fact so the import renders the same
    fingerprint; omitted fields fall back to freshly generated values."""
    try:
        major = chrome_major_of(kernel_version)
    except ValueError:
        major = int(entry.get("chrome_major") or 0) or 150

    persona = generate_persona(major, kernel_version)
    for field_name in _PERSONA_FIELDS:
        if field_name in ("chrome_major", "ua"):
            continue
        value = entry.get(field_name)
        if value not in (None, "", []):
            setattr(persona, field_name, value)
    captured_webgl = entry.get("captured_webgl")
    if isinstance(captured_webgl, dict):
        persona.captured_webgl = captured_webgl

    device_type = entry.get("device_type")
    if device_type in ("android", "desktop"):
        persona.device_type = device_type
    android_model = entry.get("android_model")
    if isinstance(android_model, str) and android_model:
        persona.android_model = android_model
    android_os_major = entry.get("android_os_major")
    if isinstance(android_os_major, int) and not isinstance(android_os_major, bool):
        persona.android_os_major = android_os_major
    captured = entry.get("captured")
    if isinstance(captured, dict):
        persona.captured = _manifest_to_captured(captured)

    ua = entry.get("ua")
    if isinstance(ua, str) and ua:
        # The UA major has to match the kernel actually launched, not the one the
        # archive was exported against.
        persona.ua = _rewrite_ua_major(ua, major)
    return persona


def _rewrite_ua_major(ua: str, major: int) -> str:
    return re.sub(r"Chrome/\d+", "Chrome/{0}".format(major), ua)
