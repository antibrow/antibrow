"""Recipe declarations: parsing, validating and filling in arguments."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import quote

from ..errors import AntibrowError

IDENTITIES = ("any", "logged-in", "anonymous")
ARG_TYPES = ("string", "number", "boolean")

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$")


class RecipeError(AntibrowError):
    """A recipe or its registry row is not usable."""


@dataclass(frozen=True)
class RecipeArg:
    name: str
    type: str
    description: Optional[str] = None
    default: Optional[Any] = None
    required: bool = False
    max: Optional[float] = None


@dataclass(frozen=True)
class RecipeMeta:
    id: str
    summary: str
    domains: Tuple[str, ...]
    entry: str
    identity: str
    args: Tuple[RecipeArg, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class RecipeEntry(RecipeMeta):
    """A registry row: the meta a recipe declares, plus how to get its bytes."""

    path: str = ""
    sha256: str = ""
    reviewed: bool = False


def validate_meta(raw: Mapping[str, Any]) -> RecipeMeta:
    """Check a declaration, whatever it came from."""
    rid = raw.get("id")
    if not isinstance(rid, str) or not _ID_RE.match(rid):
        raise RecipeError("recipe meta.id must look like <site>/<command>")
    summary = raw.get("summary")
    if not isinstance(summary, str) or not summary:
        raise RecipeError("{0}: meta.summary is required".format(rid))
    raw_domains = raw.get("domains")
    if not isinstance(raw_domains, (list, tuple)) or not raw_domains:
        raise RecipeError("{0}: meta.domains must list at least one host".format(rid))
    domains = []
    for domain in raw_domains:
        if not isinstance(domain, str) or "*" in domain or domain.startswith(".") or "." not in domain:
            raise RecipeError("{0}: meta.domains must be exact hostnames, no wildcards".format(rid))
        domains.append(domain.lower())
    entry = raw.get("entry")
    if not isinstance(entry, str) or not entry.startswith("https://"):
        raise RecipeError("{0}: meta.entry must be an https url".format(rid))
    args = _validate_args(rid, raw.get("args"))
    _assert_entry(rid, entry, domains, args)
    identity = raw.get("identity")
    if identity not in IDENTITIES:
        raise RecipeError("{0}: meta.identity must be {1}".format(rid, " | ".join(IDENTITIES)))
    return RecipeMeta(
        id=rid,
        summary=summary,
        domains=tuple(domains),
        entry=entry,
        identity=identity,
        args=args,
    )


_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _assert_entry(rid: str, entry: str, domains: List[str], args: Tuple[RecipeArg, ...]) -> None:
    """Check ``meta.entry``, which may interpolate declared arguments.

    Sites that only render results on a real navigation (Google answers a fetch
    for its own result page with a redirect interstitial) are unreachable
    otherwise, because a recipe cannot navigate once it is running. The host
    stays literal on purpose: it is what ``meta.domains`` is checked against, and
    an argument-controlled host would let a caller point a reviewed recipe at any
    site with that profile's cookies.
    """
    declared = {arg.name for arg in args}
    for name in _PLACEHOLDER_RE.findall(entry):
        if name not in declared:
            raise RecipeError(
                "{0}: meta.entry uses {{{1}}}, which is not a declared argument".format(rid, name)
            )
    authority = entry.split("://", 1)[1].split("/", 1)[0]
    if "{" in authority:
        raise RecipeError("{0}: meta.entry may not interpolate the host".format(rid))
    host = authority.split("@")[-1].split(":")[0].lower()
    if host not in domains:
        raise RecipeError("{0}: meta.entry host is not in meta.domains".format(rid))


def resolve_entry(meta: RecipeMeta, args: Mapping[str, Any]) -> str:
    """The entry url for one run, with declared arguments interpolated."""

    def replace(match: "re.Match[str]") -> str:
        value = args.get(match.group(1))
        return "" if value is None else quote(str(value), safe="")

    return _PLACEHOLDER_RE.sub(replace, meta.entry)


def _validate_args(rid: str, raw: Any) -> Tuple[RecipeArg, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, (list, tuple)):
        raise RecipeError("{0}: meta.args must be a list".format(rid))
    args = []
    for item in raw:
        if not isinstance(item, Mapping) or not isinstance(item.get("name"), str) or not item.get("name"):
            raise RecipeError("{0}: every meta.args entry needs a name".format(rid))
        if item.get("type") not in ARG_TYPES:
            raise RecipeError(
                "{0}: argument {1} needs type {2}".format(rid, item["name"], " | ".join(ARG_TYPES))
            )
        args.append(
            RecipeArg(
                name=item["name"],
                type=item["type"],
                description=item.get("description"),
                default=item.get("default"),
                required=bool(item.get("required")),
                max=item.get("max"),
            )
        )
    return tuple(args)


def entry_from_row(row: Mapping[str, Any]) -> RecipeEntry:
    """Turn one published registry row into an entry, rejecting a bad one."""
    meta = validate_meta(row)
    path = row.get("path")
    if not isinstance(path, str) or ".." in path or path.startswith("/"):
        raise RecipeError("{0}: registry path is not a relative file path".format(meta.id))
    digest = row.get("sha256")
    if not isinstance(digest, str) or not re.match(r"^[0-9a-f]{64}$", digest):
        raise RecipeError("{0}: registry entry has no sha256".format(meta.id))
    return RecipeEntry(
        id=meta.id,
        summary=meta.summary,
        domains=meta.domains,
        entry=meta.entry,
        identity=meta.identity,
        args=meta.args,
        path=path,
        sha256=digest,
        reviewed=row.get("reviewed") is True,
    )


_DECL_ID_RE = re.compile(r"\bid\s*:\s*['\"]([^'\"]+)['\"]")
_DECL_ENTRY_RE = re.compile(r"\bentry\s*:\s*['\"]([^'\"]+)['\"]")
_DECL_IDENTITY_RE = re.compile(r"\bidentity\s*:\s*['\"]([^'\"]+)['\"]")
_DECL_DOMAINS_RE = re.compile(r"\bdomains\s*:\s*\[([^\]]*)\]")
_STRING_RE = re.compile(r"['\"]([^'\"]+)['\"]")


def extract_declared(source: str) -> Dict[str, Any]:
    """Read id / entry / identity / domains out of a recipe's text.

    Deliberately a text-level read, not a JavaScript parser: the only thing it
    has to do is notice a file and the registry row that advertised it
    disagreeing, which is how a recipe would end up running with a wider
    allowlist than the one a reviewer signed off on. Anything it cannot read is
    an error, never a skipped check.
    """
    # Only the declaration block is searched: run() bodies routinely build
    # objects with an `id` field of their own, and the first match wins.
    head = re.split(r"\bfunction\s+run\b", source, maxsplit=1)[0]
    found = {}
    for key, pattern in (("id", _DECL_ID_RE), ("entry", _DECL_ENTRY_RE), ("identity", _DECL_IDENTITY_RE)):
        match = pattern.search(head)
        if not match:
            raise RecipeError("recipe declares no meta.{0}".format(key))
        found[key] = match.group(1)
    domains = _DECL_DOMAINS_RE.search(head)
    if not domains:
        raise RecipeError("recipe declares no meta.domains")
    hosts = [h.lower() for h in _STRING_RE.findall(domains.group(1))]
    if not hosts:
        raise RecipeError("recipe declares an empty meta.domains")
    found["domains"] = hosts
    found["args"] = _extract_args(head)
    return found


_DECL_ARGS_RE = re.compile(r"\bargs\s*:\s*\[(.*?)\]\s*,?\s*\}", re.S)
_ARG_ENTRY_RE = re.compile(r"\{([^{}]*)\}")
_ARG_FIELD_RE = re.compile(r"(\w+)\s*:\s*('[^']*'|\"[^\"]*\"|true|false|-?\d+(?:\.\d+)?)")


def _extract_args(head: str) -> List[Dict[str, Any]]:
    """The ``args`` array, for running a local working copy.

    Only reached by ``recipe test``: a published recipe's arguments come from the
    registry row. Without it a local run would reject every ``--args`` value as
    undeclared and apply no defaults, so the same file would behave differently
    depending on which SDK ran it.
    """
    block = _DECL_ARGS_RE.search(head)
    if not block:
        return []
    out: List[Dict[str, Any]] = []
    for entry in _ARG_ENTRY_RE.finditer(block.group(1)):
        arg: Dict[str, Any] = {}
        for name, raw in _ARG_FIELD_RE.findall(entry.group(1)):
            arg[name] = _literal(raw)
        if arg.get("name"):
            out.append(arg)
    return out


def _literal(raw: str) -> Any:
    if raw[0] in "'\"":
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    return float(raw) if "." in raw else int(raw)


def assert_source_matches_entry(entry: RecipeEntry, source: str) -> None:
    """The row is what a reviewer read; the file is what runs."""
    declared = extract_declared(source)
    if declared["id"] != entry.id:
        raise RecipeError("{0}: file declares id {1}".format(entry.id, declared["id"]))
    if declared["entry"] != entry.entry:
        raise RecipeError("{0}: file and registry disagree on meta.entry".format(entry.id))
    if declared["identity"] != entry.identity:
        raise RecipeError("{0}: file and registry disagree on meta.identity".format(entry.id))
    if sorted(declared["domains"]) != sorted(d.lower() for d in entry.domains):
        raise RecipeError("{0}: file and registry disagree on meta.domains".format(entry.id))


def coerce_args(meta: RecipeMeta, given: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Fill declared defaults and reject anything the recipe never declared.

    An unknown name is an error rather than a passthrough: the usual cause is a
    typo, and dropping it silently produces a plausible-looking answer to the
    wrong question.
    """
    given = dict(given or {})
    known = {arg.name for arg in meta.args}
    for name in given:
        if name not in known:
            listed = ", ".join(arg.name for arg in meta.args) or "(none)"
            raise RecipeError('{0}: unknown argument "{1}". Declared: {2}'.format(meta.id, name, listed))
    out: Dict[str, Any] = {}
    for arg in meta.args:
        raw = given.get(arg.name)
        if raw is None or raw == "":
            if arg.required:
                raise RecipeError('{0}: argument "{1}" is required'.format(meta.id, arg.name))
            if arg.default is not None:
                out[arg.name] = arg.default
            continue
        out[arg.name] = _coerce_one(meta.id, arg, raw)
    return out


def _coerce_one(rid: str, arg: RecipeArg, raw: Any) -> Any:
    if arg.type == "number":
        try:
            num = float(raw)
        except (TypeError, ValueError):
            raise RecipeError('{0}: argument "{1}" must be a number'.format(rid, arg.name))
        if arg.max is not None and num > arg.max:
            raise RecipeError('{0}: argument "{1}" is capped at {2}'.format(rid, arg.name, _plain(arg.max)))
        return _plain(num)
    if arg.type == "boolean":
        if isinstance(raw, bool):
            return raw
        text = str(raw).lower()
        if text in ("true", "1", "yes"):
            return True
        if text in ("false", "0", "no"):
            return False
        raise RecipeError('{0}: argument "{1}" must be true or false'.format(rid, arg.name))
    return str(raw)


def _plain(num: float) -> Any:
    """Whole numbers stay whole, so a recipe sees ``25`` and not ``25.0``."""
    return int(num) if float(num).is_integer() else num


def describe(entry: RecipeEntry) -> str:
    """Human-readable ``recipe info`` body."""
    lines = [
        "{0}{1}".format(entry.id, "" if entry.reviewed else "  [unreviewed]"),
        "  {0}".format(entry.summary),
        "  entry     {0}".format(entry.entry),
        "  domains   {0}".format(", ".join(entry.domains)),
        "  identity  {0}".format(entry.identity),
    ]
    if entry.args:
        lines.append("  args")
        for arg in entry.args:
            bits = [arg.type]
            if arg.required:
                bits.append("required")
            if arg.default is not None:
                bits.append("default {0!r}".format(arg.default))
            if arg.max is not None:
                bits.append("max {0}".format(_plain(arg.max)))
            suffix = " - {0}".format(arg.description) if arg.description else ""
            lines.append("    {0:<12} {1}{2}".format(arg.name, ", ".join(bits), suffix))
    else:
        lines.append("  args      (none)")
    return "\n".join(lines)
