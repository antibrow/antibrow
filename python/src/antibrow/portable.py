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
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, replace
from dataclasses import fields as _dataclass_fields
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from . import kernel as _kernel
from .crypt_key import CRYPT_KEY_PATTERN, fetch_profile_crypt_key
from .crypt_rekey import NO_CRYPT_KEY, RekeyRunner, run_crypt_rekey
from .errors import ProfileCacheError
from .kernel import normalize_kernel_version
from .license import get_license_token, resolve_api_key
from .persona import (
    PERSONA_FILE,
    CapturedFacts,
    Persona,
    chrome_major_of,
    generate_persona,
    read_persona,
    write_persona,
)
from .profile_cache import PASSKEYS_ENTRY, SKIP_DIRS, SKIP_FILES, clear_archive_version
from .profile_dir import (
    CRYPT_STATE_FILE,
    is_profile_encrypted,
    profile_crypt_marker,
    write_crypt_state,
)

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


def copy_portable_profile_files(src_dir: Path | str, dst_dir: Path | str) -> None:
    """Copy exactly the files a portable export reads.

    A caller that has to transform the profile first (an encrypted one is
    converted on a copy) then works on the same set that ships: anything left out
    of the copy is also left out of the archive. ``crypt-state.json`` and
    ``profile.json`` are not in it - the copy is on its way to being unencrypted,
    and the identity record is machine-local.
    """
    src, dst = Path(src_dir), Path(dst_dir)
    dst.mkdir(parents=True, exist_ok=True)
    for name in (PERSONA_FILE, PASSKEYS_ENTRY):
        _copy_file(src / name, dst / name)
    src_user_data, dst_user_data = src / "user-data", dst / "user-data"
    for rel in PORTABLE_USER_DATA:
        source = src_user_data / rel
        if source.is_dir():
            _copy_dir(source, dst_user_data / rel)
        elif source.is_file():
            _copy_file(source, dst_user_data / rel)
            for side in SQLITE_SIDES:
                _copy_file(
                    source.parent / (source.name + side), dst_user_data / (rel + side)
                )


def _copy_file(source: Path, dest: Path) -> None:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    except OSError:
        pass  # missing or locked: the pack skips it too


def _copy_dir(source: Path, dest: Path) -> None:
    """Mirrors :func:`_add_dir`'s whitelist, so the copy is what the pack packs."""
    try:
        names = sorted(p.name for p in source.iterdir())
    except OSError:
        return
    dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        if name in SKIP_FILES:
            continue
        path = source / name
        if path.is_dir():
            if name in SKIP_DIRS:
                continue
            _copy_dir(path, dest / name)
        elif path.is_file():
            _copy_file(path, dest / name)


def export_profile_archive(
    profile_dir: Path | str,
    meta: PortableProfileMeta,
    *,
    crypt_key: Optional[str] = None,
    get_crypt_key: Optional[Callable[[], Optional[str]]] = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    cache_dir: Optional[Path | str] = None,
    exe_path: Optional[Path | str] = None,
    license_token: Optional[str] = None,
    tmp_dir: Optional[Path | str] = None,
    timeout: Optional[float] = None,
    rekey: Optional[RekeyRunner] = None,
    on_progress: Optional[Callable[[str], None]] = None,
) -> bytes:
    """Build a portable ``.fpprofile`` from any profile, encrypted or not.

    Export with the browser closed: a live browser holds SQLite mid-write, and a
    torn copy loses cookies and tabs on import.

    An encrypted profile's key never enters its directory, so packing the
    directory would hand the recipient ciphertext and nothing to open it with.
    Such a profile is copied to a temporary directory, converted there to the
    kernel's built-in key, and packed from the copy - which needs its key, a
    kernel and a licence, hence the keyword arguments above. The profile itself
    is never touched, and the archive opens anywhere, which is what export means.
    """
    root = Path(profile_dir)
    persona = _read_exportable_persona(root, meta)
    if not is_profile_encrypted(root):
        return _pack_profile_archive(root, meta)

    # Refuse before copying anything. Both branches mean the directory's own
    # records disagree with its data, and converting on a guess would either
    # destroy the copy or produce an archive that only looks converted.
    before = profile_crypt_marker(root / "user-data")
    if before != "key-bound":
        raise ProfileCacheError(
            "This profile is recorded as encrypted, but its browser data carries no encryption "
            "verifier ({0}). Open it once and export again; exporting now could produce an "
            "unusable file.".format(before)
        )

    key = crypt_key or _resolve_export_crypt_key(meta, get_crypt_key, api_key, server)
    if not key or not CRYPT_KEY_PATTERN.match(key):
        raise ProfileCacheError(
            "This profile is encrypted and its encryption key could not be obtained, so it "
            "cannot be exported. Sign in to the account that owns it and try again."
        )

    convert = rekey or _default_rekey_runner(
        persona.kernel_version or meta.kernel_version,
        cache_dir=cache_dir,
        exe_path=exe_path,
        license_token=license_token,
        api_key=api_key,
        server=server,
        timeout=timeout,
        on_progress=on_progress,
    )
    staging = Path(tempfile.mkdtemp(prefix="antibrow-export-", dir=str(tmp_dir) if tmp_dir else None))
    try:
        copy = staging / "profile"
        if on_progress:
            on_progress("Preparing a decrypted copy for export")
        copy_portable_profile_files(root, copy)
        convert(copy / "user-data", key, NO_CRYPT_KEY)

        # Chromium ignores switches it does not know, so a kernel without this
        # feature starts, converts nothing and exits successfully. Verify the
        # outcome rather than the kernel's version: the verifier below is written
        # by the kernel when the key is bound and removed only by the conversion,
        # so an untouched copy still carries it.
        after = profile_crypt_marker(copy / "user-data")
        if after != "plain":
            raise ProfileCacheError(
                "The kernel did not convert this profile (its data is still {0}). This kernel "
                "build has no --fp-crypt-rekey support; update it and export again. No file "
                "was written.".format("encrypted" if after == "key-bound" else "unreadable")
            )
        # The id defaults to the directory's own name, and the copy's name is not
        # the profile's - pin it before packing from somewhere else.
        pinned = replace(meta, id=meta.id or root.name)
        return _pack_profile_archive(copy, pinned)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _resolve_export_crypt_key(
    meta: PortableProfileMeta,
    get_crypt_key: Optional[Callable[[], Optional[str]]],
    api_key: Optional[str],
    server: Optional[str],
) -> Optional[str]:
    if get_crypt_key is not None:
        return get_crypt_key()
    key = resolve_api_key(api_key)
    if not key:
        return None
    return fetch_profile_crypt_key(meta.name, key, server)


def _default_rekey_runner(
    kernel_version: Optional[str],
    *,
    cache_dir: Optional[Path | str],
    exe_path: Optional[Path | str],
    license_token: Optional[str],
    api_key: Optional[str],
    server: Optional[str],
    timeout: Optional[float],
    on_progress: Optional[Callable[[str], None]],
) -> RekeyRunner:
    """Resolves the kernel and the licence lazily, so a supplied runner needs neither."""

    def run(user_data_dir: Path, from_key: str, to_key: str) -> None:
        binary = exe_path or _resolve_kernel_exe(kernel_version, cache_dir, on_progress)
        # The conversion mode verifies the licence before it parses anything else,
        # and holds a concurrency slot while it runs, same as a launch.
        token = license_token or get_license_token(api_key, server).token
        run_crypt_rekey(
            exe_path=binary,
            user_data_dir=user_data_dir,
            from_key=from_key,
            to_key=to_key,
            license_token=token,
            platform=_kernel.current_platform(),
            timeout=timeout,
            on_progress=on_progress,
        )

    return run


def _resolve_kernel_exe(
    kernel_version: Optional[str],
    cache_dir: Optional[Path | str],
    on_progress: Optional[Callable[[str], None]],
) -> Path:
    if not cache_dir:
        raise ProfileCacheError(
            "Cannot locate the browser kernel for the export: pass cache_dir or exe_path."
        )
    # Versions published after this release exist only in the manifest, so the
    # catalogue has to be refreshed before the lookup - exactly the reasoning
    # behind the Android floor's strict resolution. A lenient lookup on a stale
    # catalogue would silently convert on whatever kernel happens to be compiled
    # in, rather than the one this profile is actually pinned to.
    _kernel.refresh_kernel_versions(cache_dir)
    kv = _kernel.find_kernel_version_strict(normalize_kernel_version(kernel_version))
    return _kernel.ensure_kernel(cache_dir, kv, on_progress)


def _read_exportable_persona(root: Path, meta: PortableProfileMeta) -> Persona:
    """The identity an export will carry, or the refusal that stops it.

    Separate from the packing itself so a caller that has to prepare the
    directory first (an encrypted profile is converted on a copy) is refused
    before doing the work.
    """
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
    return persona


def _pack_profile_archive(profile_dir: Path | str, meta: PortableProfileMeta) -> bytes:
    """Zip the directory as it stands.

    The key never enters the profile directory, so this refuses an encrypted one:
    packing it produces ciphertext nobody can open, the exporter included. The
    converted copy :func:`export_profile_archive` builds carries no marker, which
    is what lets it through here.
    """
    root = Path(profile_dir)
    persona = _read_exportable_persona(root, meta)
    if is_profile_encrypted(root):
        raise ProfileCacheError(
            "This profile is encrypted, so packing it as it stands would produce a file nobody "
            "can open."
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
            "kernel_version": normalize_kernel_version(meta.kernel_version or persona.kernel_version),
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


def _settle_imported_crypt_state(root: Path, archive_said_so: bool) -> None:
    """State the imported data's encryption for a directory that may have held a
    different profile before.

    A restore cannot go stale - a profile's encryption never changes and its own
    archive always carries the answer - but an import replaces the data wholesale,
    and a marker left from the previous occupant would put a key on data that was
    never written under one. The question is what the ARCHIVE said, so it cannot
    be answered by re-reading the directory: the stale file is still sitting there.
    """
    if not archive_said_so:
        write_crypt_state(root, False)


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
    # The portable format carries neither the marker nor a key, so what lands here
    # is unencrypted as far as this machine can act on it.
    _settle_imported_crypt_state(root, False)

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
    _settle_imported_crypt_state(root, CRYPT_STATE_FILE in zf.namelist())

    rest = {key: value for key, value in legacy.items() if key not in ("name", "kernelVersion")}
    version = legacy.get("kernelVersion")
    return ImportedProfileMeta(
        source="legacy",
        name=legacy.get("name") if isinstance(legacy.get("name"), str) else "",
        kernel_version=normalize_kernel_version(version) if isinstance(version, str) else None,
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

    The exact version, else the default - an archive from another machine must
    not be unlaunchable.

    An Android profile gets none of that latitude. Its version is a pin, not a
    preference, and rewriting it to a kernel without the mobile patches would
    turn the import into a profile that claims to be a phone and cannot behave
    like one.
    """
    want = normalize_kernel_version(wanted)
    try:
        known: List[str] = [kv.version for kv in _kernel.kernels_for_platform()]
    except Exception:
        known = []
    if want in known:
        return want
    if android:
        raise ProfileCacheError(
            "This Android profile needs kernel {0}, which is not in the catalogue here. "
            "Refresh the kernel list with an internet connection and import again.".format(want)
        )
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
