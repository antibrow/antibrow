"""``python -m antibrow`` - install the kernel, inspect the cache, run recipes."""

from __future__ import annotations

import argparse
import fnmatch
import getpass
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

from . import __version__
from . import config as _config
from . import kernel as _kernel
from . import license as _license
from . import reaper as _reaper
from .errors import AntibrowError
from .persona import read_persona


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return "{0:.0f} {1}".format(size, unit) if unit == "B" else "{0:.1f} {1}".format(size, unit)
        size /= 1024
    return "{0:.1f} GB".format(size)


def _progress_printer():
    state = {"last": ""}

    def report(message: str) -> None:
        if message == state["last"]:
            return
        state["last"] = message
        # Overwrite in place for percentage spam, newline for real steps.
        if message.startswith(("Downloading ", "Extracting ")) and message.rstrip().endswith(("%", "...")):
            sys.stdout.write("\r  {0:<50}".format(message))
            sys.stdout.flush()
        else:
            sys.stdout.write("\r{0:<60}\r  {1}\n".format("", message))
            sys.stdout.flush()

    return report


def cmd_install(args: argparse.Namespace) -> int:
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir else _config.default_cache_dir()
    try:
        platform = _kernel.current_platform()
    except AntibrowError as exc:
        print("error: {0}".format(exc), file=sys.stderr)
        return 2

    # Forced so `--version` can name a freshly published build; also seeds the
    # on-disk catalogue cache that later (possibly offline) launches read.
    _kernel.refresh_kernel_versions(cache_dir, force=True)
    # A pinned version may still be a full one copied from an older release's help text.
    wanted = _kernel.normalize_kernel_version(args.version) if args.version else None
    kv = _kernel.find_kernel_version(args.version) if args.version else _kernel.default_kernel_version()
    if wanted and kv.version != wanted:
        print(
            "error: unknown kernel version {0!r}. Available: {1}".format(
                args.version, ", ".join(k.version for k in _kernel.kernels_for_platform(platform))
            ),
            file=sys.stderr,
        )
        return 2
    if not kv.available_on(platform):
        print(
            "error: kernel {0} has no {1} build.".format(kv.version, platform),
            file=sys.stderr,
        )
        return 2

    print("Installing kernel {0} ({1}) into {2}".format(kv.label, kv.version, cache_dir))
    try:
        exe_path = _kernel.ensure_kernel(cache_dir, kv, _progress_printer(), force=args.force)
    except AntibrowError as exc:
        print("\nerror: {0}".format(exc), file=sys.stderr)
        return 1
    size = _kernel.kernel_dir_size(cache_dir, kv.version)
    print("  Installed: {0} ({1})".format(exe_path, _human_size(size)))
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir else _config.default_cache_dir()
    try:
        platform: Optional[str] = _kernel.current_platform()
    except AntibrowError:
        platform = None

    print("antibrow {0}".format(__version__))
    print("  python       {0}".format(sys.version.split()[0]))
    print("  platform     {0}{1}".format(sys.platform, "" if platform else "  (UNSUPPORTED)"))
    print("  cache dir    {0}".format(cache_dir))
    print("  config dir   {0}".format(_config.config_dir()))
    print("  server       {0}".format(_config.default_server()))

    online = _kernel.refresh_kernel_versions(cache_dir, force=True)
    print(
        "\nKernels ({0}):".format(
            "manifest reachable"
            if online
            else "offline, showing the built-in version plus any cached ones"
        )
    )
    versions = _kernel.kernels_for_platform(platform) if platform else _kernel.all_kernel_versions()
    for kv in versions:
        installed = platform is not None and _kernel.is_kernel_installed(cache_dir, kv, platform)
        marks: List[str] = []
        if installed:
            marks.append(_human_size(_kernel.kernel_dir_size(cache_dir, kv.version)))
            status = _kernel.kernel_update_status(cache_dir, kv.version, platform)
            if status is not None and status.update_available:
                marks.append("update available")
        default_kv = _kernel.default_kernel_version()
        if kv.version == default_kv.version:
            marks.append("default for new profiles")
        print(
            "  [{0}] {1:<16} {2:<11} {3}".format(
                "x" if installed else " ", kv.version, kv.label, ", ".join(marks)
            )
        )
    if platform and not _kernel.list_installed_kernels(cache_dir, platform):
        print("  (nothing installed yet - run `python -m antibrow install`)")

    profiles = _config.list_profiles(cache_dir)
    print("\nProfiles ({0}):".format(len(profiles)))
    for name in profiles[:40]:
        directory = _config.profiles_dir(cache_dir) / name
        # read_persona, not a raw file read: it normalizes, so this listing
        # agrees with the catalogue above and with what `install --version` takes.
        persona = read_persona(directory)
        version = (persona.kernel_version if persona else None) or "-"
        print("  {0:<32} kernel {1}".format(name, version))
    if len(profiles) > 40:
        print("  ... and {0} more".format(len(profiles) - 40))
    if not profiles:
        print("  (none yet - profiles are created on first launch)")

    source = _license.api_key_source()
    print("\nLicense:")
    print("  api key      {0}".format(source or "NOT CONFIGURED - run `python -m antibrow login`"))
    if os.environ.get(_config.ENV_LICENSE_TOKEN):
        print("  token        from ${0}".format(_config.ENV_LICENSE_TOKEN))
    key = _license.resolve_api_key()
    if key:
        cached = _license._read_cache(_license._cache_file(key, _config.default_server()))
        if cached is None:
            print("  cached token none (one will be minted on first launch)")
        else:
            remaining = cached.expires_in
            print(
                "  cached token {0} (expires in {1}), concurrency {2}, cloud sync {3}".format(
                    "valid" if remaining > 0 else "expired",
                    time.strftime("%Hh %Mm", time.gmtime(max(remaining, 0))),
                    cached.mi,
                    "yes" if cached.sync else "no",
                )
            )
    return 0


def cmd_clear_temp(args: argparse.Namespace) -> int:
    from .temporary_profiles import clear_temporary_profiles

    if args.older_than is not None and (not math.isfinite(args.older_than) or args.older_than < 0):
        print("error: invalid --older-than value: {0}".format(args.older_than), file=sys.stderr)
        return 1

    cleared = clear_temporary_profiles(
        args.cache_dir,
        older_than_days=args.older_than,
        dry_run=args.dry_run,
    )
    verb = "would remove" if args.dry_run else "removed"
    for item in cleared:
        print("{0} {1}".format(verb, item.name))
    total = sum(item.bytes for item in cleared)
    print(
        "{0} temporary profile(s), {1}{2}".format(
            len(cleared), _human_size(total), " (dry run)" if args.dry_run else ""
        )
    )
    return 0


def cmd_login(args: argparse.Namespace) -> int:
    server = args.server or _config.default_server()
    key = args.key or os.environ.get(_config.ENV_API_KEY)
    if not key:
        if not sys.stdin.isatty():
            print(
                "error: no API key given. Use `python -m antibrow login --key <key>` "
                "or set ${0}.".format(_config.ENV_API_KEY),
                file=sys.stderr,
            )
            return 2
        print("Get a free API key at https://antibrow.com (dashboard -> API keys).")
        key = getpass.getpass("AntiBrow API key: ").strip()
    if not key:
        print("error: empty API key", file=sys.stderr)
        return 2

    print("Verifying against {0} ...".format(server))
    try:
        info = _license.fetch_license_token(key, server)
    except AntibrowError as exc:
        print("error: {0}".format(exc), file=sys.stderr)
        return 1

    path = _license.write_key_file(key)
    print("  key stored in {0}".format(path))
    print("  concurrent browsers: {0}".format(info.mi))
    print("  cloud profile sync:  {0}".format("yes" if info.sync else "no"))
    print("  token valid for:     {0}".format(time.strftime("%Hh %Mm", time.gmtime(max(info.expires_in, 0)))))
    return 0


def cmd_reap(args: argparse.Namespace) -> int:
    """Kill kernels a previous run left behind.

    Every launch already does this; the command exists for the case where the
    next launch is not the thing you want to run next.
    """
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir else _config.default_cache_dir()
    reaped = _reaper.reap_orphans(cache_dir)
    if not reaped:
        print("no orphan browsers found")
        return 0
    for pid in reaped:
        print("killed orphan browser pid {0}".format(pid))
    return 0


def cmd_version(args: argparse.Namespace) -> int:
    print("antibrow {0}".format(__version__))
    default_kv = _kernel.default_kernel_version()
    print("  default kernel  {0} ({1})".format(default_kv.version, default_kv.label))
    try:
        print("  platform        {0}".format(_kernel.current_platform()))
    except AntibrowError as exc:
        print("  platform        unsupported ({0})".format(exc))
    return 0


# ---------------------------------------------------------------- recipes ----

_SCAFFOLD = """export const meta = {{
  id: '{0}',
  summary: 'One sentence: what this command returns.',
  // Every host the recipe may reach. Exact hostnames, no wildcards.
  domains: ['example.com'],
  entry: 'https://example.com/',
  identity: 'any',
  args: [
    {{ name: 'limit', type: 'number', default: 25, max: 100 }},
  ],
}}

// Runs inside the page: relative fetches carry this profile's session for the
// site, and document/window are available. There is no fs, no process, no goto.
export async function run(ctx, args) {{
  const res = await ctx.fetchJson(`/some/endpoint.json?limit=${{args.limit}}`)
  return {{ items: res.items }}
}}
"""


def _recipe_cache_dir(args: argparse.Namespace) -> Optional[Path]:
    return Path(args.cache_dir).expanduser() if getattr(args, "cache_dir", None) else None


def _recipe_args(args: argparse.Namespace) -> Dict[str, Any]:
    if not getattr(args, "args", None):
        return {}
    try:
        parsed = json.loads(args.args)
    except ValueError:
        raise AntibrowError("--args must be a JSON object, e.g. --args '{\"limit\":5}'")
    if not isinstance(parsed, dict):
        raise AntibrowError("--args must be a JSON object")
    return parsed


def _recipe_shaped(value: Any, args: argparse.Namespace) -> Any:
    from .recipe import apply_filter

    return apply_filter(value, args.jq) if getattr(args, "jq", None) else value


def _print_run(result: Any, args: argparse.Namespace) -> None:
    if result.blocked_hosts:
        print(
            "blocked hosts (not in meta.domains): {0}".format(", ".join(result.blocked_hosts)),
            file=sys.stderr,
        )
    value = _recipe_shaped(result.value, args)
    if args.json:
        print(
            json.dumps(
                {
                    "id": result.id,
                    "profile": result.profile,
                    "durationMs": result.duration_ms,
                    "blockedHosts": list(result.blocked_hosts),
                    "logs": list(result.logs),
                    "value": value,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False))
        print("{0} on {1} in {2}ms".format(result.id, result.profile, result.duration_ms), file=sys.stderr)


def cmd_recipe_update(args: argparse.Namespace) -> int:
    from .recipe import update_recipes

    result = update_recipes(_recipe_cache_dir(args), accept_changes=args.accept_changes)
    print("{0} recipe(s) from {1}".format(len(result.registry.recipes), result.url))
    if result.added:
        print("  new: {0}".format(", ".join(result.added)))
    if result.changed:
        print("  changed: {0}".format(", ".join(result.changed)))
    return 0


def cmd_recipe_list(args: argparse.Namespace) -> int:
    from .recipe import load_registry

    rows = [
        entry
        for entry in load_registry(_recipe_cache_dir(args)).recipes
        if not args.site or entry.id.split("/")[0] == args.site
    ]
    if args.json:
        print(
            json.dumps(
                [
                    {
                        "id": e.id,
                        "summary": e.summary,
                        "domains": list(e.domains),
                        "entry": e.entry,
                        "identity": e.identity,
                        "reviewed": e.reviewed,
                    }
                    for e in rows
                ],
                indent=2,
            )
        )
        return 0
    if not rows:
        print("no recipes for site {0!r}".format(args.site) if args.site else "the registry is empty", file=sys.stderr)
        return 1
    width = max(len(e.id) for e in rows)
    for entry in rows:
        print("{0}  {1} {2}".format(entry.id.ljust(width), " " if entry.reviewed else "!", entry.summary))
    print("! = not reviewed, runs only on a temporary profile with --allow-unreviewed", file=sys.stderr)
    return 0


def cmd_recipe_info(args: argparse.Namespace) -> int:
    from .recipe import describe, load_registry

    entry = load_registry(_recipe_cache_dir(args)).find(args.id)
    if args.json:
        print(
            json.dumps(
                {
                    "id": entry.id,
                    "summary": entry.summary,
                    "domains": list(entry.domains),
                    "entry": entry.entry,
                    "identity": entry.identity,
                    "reviewed": entry.reviewed,
                    "path": entry.path,
                    "sha256": entry.sha256,
                    "args": [
                        {
                            "name": a.name,
                            "type": a.type,
                            "description": a.description,
                            "default": a.default,
                            "required": a.required,
                            "max": a.max,
                        }
                        for a in entry.args
                    ],
                },
                indent=2,
            )
        )
        return 0
    print(describe(entry))
    return 0


def _recipe_launch(args: argparse.Namespace) -> Any:
    from .recipe import RecipeLaunch

    return RecipeLaunch(
        api_key=getattr(args, "key", None),
        server=getattr(args, "server", None),
        cache_dir=_recipe_cache_dir(args),
        profile=args.profile,
        temporary=args.temporary or not args.profile,
        headless=args.headless,
        args=_recipe_args(args),
        timeout=args.timeout,
        on_log=lambda message: print("  {0}".format(message), file=sys.stderr),
    )


def cmd_recipe_run(args: argparse.Namespace) -> int:
    from .recipe import resolve_published, run_recipe_source

    launch = _recipe_launch(args)
    entry, source = resolve_published(
        args.id,
        temporary=launch.temporary,
        allow_unreviewed=args.allow_unreviewed,
        cache_dir=launch.cache_dir,
    )
    _print_run(run_recipe_source(entry, source, launch), args)
    return 0


def cmd_recipe_test(args: argparse.Namespace) -> int:
    from .recipe import run_recipe_source, validate_meta
    from .recipe.source import extract_declared

    root = Path(args.dir).expanduser() if args.dir else Path.cwd()
    file = Path(args.id) if args.id.endswith(".js") else root / "sites" / "{0}.recipe.js".format(args.id)
    if not file.exists():
        print(
            "error: no local recipe at {0}. Run this from the recipes checkout, "
            "or use `recipe run`.".format(file),
            file=sys.stderr,
        )
        return 1
    source = file.read_text(encoding="utf-8")
    declared = extract_declared(source)
    print("running the working copy at {0}".format(file), file=sys.stderr)
    # Only the declaration is read from the file; a summary is not needed to run.
    meta = validate_meta(dict(declared, summary="local working copy"))
    _print_run(run_recipe_source(meta, source, _recipe_launch(args)), args)
    return 0


def cmd_recipe_fanout(args: argparse.Namespace) -> int:
    from .recipe import fanout_recipe

    cache_dir = _recipe_cache_dir(args) or _config.default_cache_dir()
    profiles: List[str] = []
    for pattern in (args.profiles or "").split(","):
        pattern = pattern.strip()
        if not pattern:
            continue
        if "*" not in pattern:
            profiles.append(pattern)
            continue
        matched = fnmatch.filter(_config.list_profiles(cache_dir), pattern)
        if not matched:
            raise AntibrowError("no local profile matches {0!r}".format(pattern))
        profiles.extend(sorted(matched))
    if not profiles:
        raise AntibrowError("recipe fanout needs --profiles <name-or-pattern>")

    result = fanout_recipe(
        args.id,
        profiles,
        concurrency=args.concurrency,
        api_key=getattr(args, "key", None),
        server=getattr(args, "server", None),
        cache_dir=_recipe_cache_dir(args),
        notify=lambda message: print(message, file=sys.stderr),
        on_row=lambda row: print(
            "  {0} {1}".format(row.profile, "ok" if row.ok else "failed: {0}".format(row.error)),
            file=sys.stderr,
        ),
        allow_unreviewed=args.allow_unreviewed,
        headless=args.headless,
        args=_recipe_args(args),
        timeout=args.timeout,
    )
    if args.json:
        print(
            json.dumps(
                {
                    "id": result.id,
                    "concurrency": result.concurrency,
                    "results": [
                        {
                            "profile": row.profile,
                            "ok": row.ok,
                            "error": row.error,
                            "value": _recipe_shaped(row.result.value, args) if row.result else None,
                        }
                        for row in result.rows
                    ],
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        for row in result.rows:
            print("--- {0}".format(row.profile))
            if row.ok and row.result is not None:
                value = _recipe_shaped(row.result.value, args)
                print(value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False))
            else:
                print("error: {0}".format(row.error))
    return 0 if result.ok else 1


def cmd_recipe_scaffold(args: argparse.Namespace) -> int:
    import re as _re

    if not _re.match(r"^[a-z0-9-]+/[a-z0-9-]+$", args.id):
        raise AntibrowError("recipe scaffold needs <site>/<command>, lowercase")
    root = Path(args.dir).expanduser() if args.dir else Path.cwd()
    file = root / "sites" / "{0}.recipe.js".format(args.id)
    if file.exists():
        print("error: {0} already exists".format(file), file=sys.stderr)
        return 1
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(_SCAFFOLD.format(args.id), encoding="utf-8")
    print(file)
    print("next: edit it, then `python -m antibrow recipe test {0}`".format(args.id), file=sys.stderr)
    return 0


def cmd_recipe_guide(args: argparse.Namespace) -> int:
    from . import _http
    from .recipe import recipes_dir, registry_url

    cached = recipes_dir(_recipe_cache_dir(args)) / "GUIDE.md"
    url = urljoin(registry_url(), "GUIDE.md")
    status, text = _http.send("GET", url, accept_json=False)
    if status == 200:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(text, encoding="utf-8")
        print(text)
        return 0
    if cached.exists():
        print("showing the cached guide (HTTP {0})".format(status), file=sys.stderr)
        print(cached.read_text(encoding="utf-8"))
        return 0
    print("error: could not fetch the guide (HTTP {0}). Read it at {1}".format(status, url), file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m antibrow",
        description="AntiBrow - the antidetect browser your AI agent can drive.",
    )
    sub = parser.add_subparsers(dest="command")

    install = sub.add_parser("install", help="download and extract the browser kernel")
    install.add_argument("--version", help="kernel version, e.g. 151")
    install.add_argument("--force", action="store_true", help="re-download even if installed")
    install.add_argument("--cache-dir", help="override the cache directory")
    install.set_defaults(func=cmd_install)

    info = sub.add_parser("info", help="show kernels, profiles and license status")
    info.add_argument("--cache-dir", help="override the cache directory")
    info.set_defaults(func=cmd_info)

    clear_temp = sub.add_parser("clear-temp", help="delete temporary profiles")
    clear_temp.add_argument("--older-than", type=float, help="only those unused for this many days")
    clear_temp.add_argument("--dry-run", action="store_true", help="report without deleting")
    clear_temp.add_argument("--cache-dir", help="override the cache directory")
    clear_temp.set_defaults(func=cmd_clear_temp)

    login = sub.add_parser("login", help="store an API key in ~/.antibrow/license.key")
    login.add_argument("--key", help="API key (prompted for when omitted)")
    login.add_argument("--server", help="license server base URL")
    login.set_defaults(func=cmd_login)

    reap = sub.add_parser("reap", help="kill browsers a previous run left running")
    reap.add_argument("--cache-dir", help="override the cache directory")
    reap.set_defaults(func=cmd_reap)

    version = sub.add_parser("version", help="show SDK and default kernel versions")
    version.set_defaults(func=cmd_version)

    recipe = sub.add_parser("recipe", help="task-level site adapters: one command, structured JSON")
    recipe_sub = recipe.add_subparsers(dest="recipe_command")
    recipe.set_defaults(func=lambda _args: (recipe.print_help(), 0)[1])

    def _shared(target: argparse.ArgumentParser, *, launches: bool = False) -> None:
        target.add_argument("--cache-dir", help="override the cache directory")
        target.add_argument("--json", action="store_true", help="machine-readable output")
        if not launches:
            return
        target.add_argument("--profile", help="profile to run on")
        target.add_argument("--temporary", action="store_true", help="run on a throwaway local profile")
        target.add_argument("--args", help="recipe arguments as JSON, e.g. --args '{\"limit\":5}'")
        target.add_argument("--jq", help="trim the output: .items[].title, .items[0], length, keys, |")
        target.add_argument("--allow-unreviewed", action="store_true", help="run a recipe nobody reviewed")
        target.add_argument("--headless", action="store_true", help="no window")
        target.add_argument("--timeout", type=float, default=60.0, help="per-run limit in seconds")
        target.add_argument("--key", help="API key (defaults to the environment or key file)")
        target.add_argument("--server", help="license server base URL")

    r_update = recipe_sub.add_parser("update", help="pull the registry and pin what it names")
    r_update.add_argument("--accept-changes", action="store_true", help="accept recipes whose bytes changed")
    _shared(r_update)
    r_update.set_defaults(func=cmd_recipe_update)

    r_list = recipe_sub.add_parser("list", help="published recipes")
    r_list.add_argument("--site", help="only recipes for this site")
    _shared(r_list)
    r_list.set_defaults(func=cmd_recipe_list)

    r_info = recipe_sub.add_parser("info", help="args, domains, identity, review state")
    r_info.add_argument("id")
    _shared(r_info)
    r_info.set_defaults(func=cmd_recipe_info)

    r_run = recipe_sub.add_parser("run", help="run one recipe and print its JSON")
    r_run.add_argument("id")
    _shared(r_run, launches=True)
    r_run.set_defaults(func=cmd_recipe_run)

    r_fanout = recipe_sub.add_parser("fanout", help="run one recipe on several profiles at once")
    r_fanout.add_argument("id")
    r_fanout.add_argument("--profiles", help="names or '*' patterns, comma-separated")
    r_fanout.add_argument("--concurrency", type=int, help="browsers at once; capped by the plan")
    _shared(r_fanout, launches=True)
    r_fanout.set_defaults(func=cmd_recipe_fanout)

    r_test = recipe_sub.add_parser("test", help="run a local working copy on a temporary profile")
    r_test.add_argument("id", help="<site>/<command> or a path to a .recipe.js file")
    r_test.add_argument("--dir", help="recipes checkout (default: the working directory)")
    _shared(r_test, launches=True)
    r_test.set_defaults(func=cmd_recipe_test)

    r_scaffold = recipe_sub.add_parser("scaffold", help="write a recipe skeleton")
    r_scaffold.add_argument("id", help="<site>/<command>")
    r_scaffold.add_argument("--dir", help="recipes checkout (default: the working directory)")
    _shared(r_scaffold)
    r_scaffold.set_defaults(func=cmd_recipe_scaffold)

    r_guide = recipe_sub.add_parser("guide", help="print the recipe authoring guide")
    _shared(r_guide)
    r_guide.set_defaults(func=cmd_recipe_guide)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\naborted", file=sys.stderr)
        return 130
    except AntibrowError as exc:
        # Commands that want a nicer message still handle it themselves; this is
        # the floor, so a bad flag never reaches the user as a traceback.
        print("error: {0}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
