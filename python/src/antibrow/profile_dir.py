"""Profile directory identity, kept byte-compatible with the Node SDK."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional, Tuple

from . import config as _config
from .config import encode_path_segment

META_FILE = "profile.json"

#: How long a "not on the server" answer is trusted before re-asking.
SERVER_RECHECK_SECONDS = 24 * 60 * 60

Origin = Literal["server", "local"]


@dataclass(frozen=True)
class ProfileMeta:
    id: str
    name: str
    origin: Origin = "local"
    server_checked_at: Optional[str] = None


@dataclass(frozen=True)
class ProfileEntry:
    id: str
    name: str
    origin: str  # "server" | "local" | "legacy"
    dir: Path
    server_checked_at: Optional[str] = None


@dataclass(frozen=True)
class ResolvedProfile:
    dir: Path
    id: str
    name: str


def read_profile_meta(directory: Path) -> Optional[ProfileMeta]:
    try:
        raw = json.loads((directory / META_FILE).read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None
    pid, name = raw.get("id"), raw.get("name")
    if not isinstance(pid, str) or not pid or not isinstance(name, str) or not name:
        return None
    checked = raw.get("serverCheckedAt")
    return ProfileMeta(
        id=pid,
        name=name,
        origin="server" if raw.get("origin") == "server" else "local",
        server_checked_at=checked if isinstance(checked, str) else None,
    )


def write_profile_meta(directory: Path, meta: ProfileMeta) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    payload = {"id": meta.id, "name": meta.name, "origin": meta.origin}
    if meta.server_checked_at:
        payload["serverCheckedAt"] = meta.server_checked_at
    (directory / META_FILE).write_text(json.dumps(payload, indent=2), encoding="utf8")


def list_profile_entries(cache_dir: Path | str | None = None) -> list[ProfileEntry]:
    root = _config.profiles_dir(cache_dir)
    if not root.is_dir():
        return []
    entries: list[ProfileEntry] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        meta = read_profile_meta(child)
        if meta is None:
            entries.append(ProfileEntry(id=child.name, name=child.name, origin="legacy", dir=child))
        else:
            entries.append(
                ProfileEntry(id=meta.id, name=meta.name, origin=meta.origin, dir=child, server_checked_at=meta.server_checked_at)
            )
    return entries


def _find_by_name(entries: list[ProfileEntry], name: str) -> Optional[ProfileEntry]:
    # Exact match, case included: the server is case-sensitive.
    hits = [e for e in entries if e.name == name]
    if len(hits) == 1:
        return hits[0]
    if hits:

        def _mtime(entry: ProfileEntry) -> float:
            try:
                return (entry.dir / META_FILE).stat().st_mtime
            except OSError:
                return 0.0

        return max(hits, key=_mtime)
    # Directories predating the identity record were named after the sanitized
    # name, so `acct:1` has to recognise its own `acct_1` or the upgrade mints a
    # second profile and abandons the first one's persona.
    sanitized = _config.sanitize_profile_name(name)
    if sanitized == name:
        return None
    return next((e for e in entries if e.origin == "legacy" and e.name == sanitized), None)


def _lookup_server_id(name: str, api_key: str, server: str) -> Tuple[Optional[str], bool]:
    """(id, answered). `answered` is False when the server could not be reached."""
    url = f"{server.rstrip('/')}/api/v1/profiles/{encode_path_segment(name)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            # Cloudflare rejects the stdlib default agent outright (error 1010).
            "User-Agent": _config.USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf8"))
    except urllib.error.HTTPError as exc:
        # 403 is the free-plan answer to this route. It is an answer - treating
        # it as an outage would re-ask on every single launch, forever.
        return (None, exc.code in (403, 404))
    except (urllib.error.URLError, OSError, ValueError):
        return (None, False)
    pid = body.get("id")
    return (pid if isinstance(pid, str) and pid else None, True)


def _holder_of(entries: list[ProfileEntry], root: Path, profile_id: str, exclude: Optional[Path]) -> Optional[Path]:
    """Directory already holding ``profile_id``, by record or by name.

    A failed rename leaves the two disagreeing, so checking ``<root>/<id>``
    alone is not enough.
    """
    by_record = next((e for e in entries if e.id == profile_id and e.dir != exclude), None)
    if by_record is not None:
        return by_record.dir
    by_name = root / profile_id
    return by_name if by_name != exclude and by_name.exists() else None


def _rename_to_id(directory: Path, profile_id: str) -> Path:
    target = directory.parent / profile_id
    if target == directory or target.exists():
        return directory
    try:
        directory.rename(target)
        return target
    except OSError:
        # Windows locks and permission errors land here. Nothing depends on the
        # directory name - the record inside it identifies the profile.
        return directory


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _needs_lookup(found: Optional[ProfileEntry]) -> bool:
    if found is None or found.origin == "legacy":
        return True
    if found.origin == "server":
        return False
    if not found.server_checked_at:
        return True
    try:
        last = datetime.fromisoformat(found.server_checked_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - last).total_seconds() >= SERVER_RECHECK_SECONDS


def resolve_profile_dir(
    profile_name: str,
    cache_dir: Path | str | None = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
) -> ResolvedProfile:
    """Directory holding ``profile_name``, preferring the server's stable id so
    the SDKs and the desktop app land on the same one. Every failure degrades to
    a local id; resolution never blocks a launch."""
    _config.sanitize_profile_name(profile_name)
    root = _config.profiles_dir(cache_dir)
    entries = list_profile_entries(cache_dir)
    found = _find_by_name(entries, profile_name)
    server_id: Optional[str] = None
    answered = False
    if api_key and server and _needs_lookup(found):
        server_id, answered = _lookup_server_id(profile_name, api_key, server)
    checked_at = _now() if answered else None

    def _create(profile_id: str, origin: Origin, stamp: Optional[str], directory: Optional[Path] = None) -> ResolvedProfile:
        target = directory if directory is not None else root / profile_id
        write_profile_meta(target, ProfileMeta(id=profile_id, name=profile_name, origin=origin, server_checked_at=stamp))
        return ResolvedProfile(dir=target, id=profile_id, name=profile_name)

    def _shadow(entry: ProfileEntry) -> None:
        """Stop answering to this name without moving or deleting anything."""
        meta = read_profile_meta(entry.dir)
        if meta is None:
            # A record-less directory gets one now, so it stays listable and
            # stops shadowing a name that belongs to another directory.
            meta = ProfileMeta(id=str(uuid.uuid4()), name=profile_name, origin="local")
        write_profile_meta(
            entry.dir,
            ProfileMeta(id=meta.id, name=f"{meta.name} (local)", origin=meta.origin, server_checked_at=meta.server_checked_at),
        )

    if found is None:
        if server_id:
            return _create(server_id, "server", None, _holder_of(entries, root, server_id, None))
        return _create(str(uuid.uuid4()), "local", checked_at)

    if server_id is None and found.origin != "legacy":
        # Nothing to align; only the negative-cache stamp can have changed.
        if checked_at:
            write_profile_meta(
                found.dir,
                ProfileMeta(id=found.id, name=profile_name, origin=found.origin, server_checked_at=checked_at),  # type: ignore[arg-type]
            )
        return ResolvedProfile(dir=found.dir, id=found.id, name=profile_name)

    # A record that already carried a server id and now gets a different one is
    # the only real namesake: some other machine's cloud profile under this name.
    foreign = found.origin == "server" and server_id is not None and server_id != found.id
    pid = server_id or str(uuid.uuid4())
    holder = _holder_of(entries, root, pid, found.dir)
    if foreign or holder is not None:
        # Two directories carrying one id make every lookup by id a coin flip,
        # so the directory already holding it keeps it and this one steps aside
        # with its data.
        _shadow(found)
        return _create(pid, "server", None, holder)

    # A locally minted id is not a claim on the name: when the server finally
    # names this profile, that is this directory being adopted, not replaced.
    directory = _rename_to_id(found.dir, pid)
    write_profile_meta(
        directory,
        ProfileMeta(id=pid, name=profile_name, origin="server" if server_id else "local", server_checked_at=None if server_id else checked_at),
    )
    return ResolvedProfile(dir=directory, id=pid, name=profile_name)
