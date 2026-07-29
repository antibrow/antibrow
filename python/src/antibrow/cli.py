"""``python -m antibrow`` - install the kernel, inspect the cache, store a key."""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time
from pathlib import Path
from typing import List, Optional

from . import __version__
from . import config as _config
from . import kernel as _kernel
from . import license as _license
from .errors import AntibrowError
from .persona import PERSONA_FILE, Persona


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

    _kernel.refresh_kernel_catalogue()  # so `--version` can name a freshly published build
    kv = _kernel.find_kernel_version(args.version) if args.version else _kernel.default_kernel_version()
    if args.version and kv.version != args.version:
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

    online = _kernel.refresh_kernel_catalogue()
    print("\nKernels ({0}):".format("manifest reachable" if online else "offline, built-in list only"))
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
        version = "-"
        try:
            import json

            data = json.loads((directory / PERSONA_FILE).read_text(encoding="utf-8"))
            version = Persona.from_dict(data).kernel_version or "-"
        except Exception:
            pass
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


def cmd_version(args: argparse.Namespace) -> int:
    print("antibrow {0}".format(__version__))
    default_kv = _kernel.default_kernel_version()
    print("  default kernel  {0} ({1})".format(default_kv.version, default_kv.label))
    try:
        print("  platform        {0}".format(_kernel.current_platform()))
    except AntibrowError as exc:
        print("  platform        unsupported ({0})".format(exc))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m antibrow",
        description="AntiBrow - the antidetect browser your AI agent can drive.",
    )
    sub = parser.add_subparsers(dest="command")

    install = sub.add_parser("install", help="download and extract the browser kernel")
    install.add_argument("--version", help="kernel version, e.g. 150.0.7871.182")
    install.add_argument("--force", action="store_true", help="re-download even if installed")
    install.add_argument("--cache-dir", help="override the cache directory")
    install.set_defaults(func=cmd_install)

    info = sub.add_parser("info", help="show kernels, profiles and license status")
    info.add_argument("--cache-dir", help="override the cache directory")
    info.set_defaults(func=cmd_info)

    login = sub.add_parser("login", help="store an API key in ~/.antibrow/license.key")
    login.add_argument("--key", help="API key (prompted for when omitted)")
    login.add_argument("--server", help="license server base URL")
    login.set_defaults(func=cmd_login)

    version = sub.add_parser("version", help="show SDK and default kernel versions")
    version.set_defaults(func=cmd_version)

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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
