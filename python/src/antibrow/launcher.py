"""Spawning the kernel and finding its CDP endpoint.

Everything here is deliberately Playwright-free so the argument assembly can be
unit-tested without a browser or a network.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, List, Optional, Sequence

from .errors import ConcurrencyLimitError, LaunchError
from .profile_cache import PASSKEYS_ENTRY
from .proxy import ProxySpec, proxy_args

ProgressCallback = Callable[[str], None]

#: Kernel stderr that means "the license's concurrency cap is already in use".
_CONCURRENCY_PATTERN = re.compile(
    r"concurren|max.*instance|instance.*limit|license.*(limit|cap|mi\b)|too many", re.IGNORECASE
)

#: How long to wait for the browser to expose /json/version.
DEFAULT_LAUNCH_TIMEOUT = 120.0


def pick_free_port() -> int:
    """Ask the OS for a free localhost port, then hand it to the kernel."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def build_launch_args(
    *,
    fp_config_path: Path | str,
    license_token: str,
    user_data_dir: Path | str,
    label: str,
    cdp_port: int,
    language: str = "en-US",
    headless: bool = False,
    platform: str = "win32",
    proxy: Optional[ProxySpec] = None,
    proxy_auth: str = "native",
    profile_dir: Optional[Path | str] = None,
    webauthn_capture: Optional[bool] = None,
    extra_args: Optional[Sequence[str]] = None,
) -> List[str]:
    """Assemble the kernel command line (without the executable itself).

    ``platform`` is explicit rather than read from :data:`sys.platform` so the
    Windows/Linux/macOS branches stay testable from any OS.
    """
    is_win = platform == "win32"
    # Both Linux asset keys: the container-only switches below are just as
    # necessary on arm64, whose kernel ships as a separate build.
    is_linux = platform in ("linux", "linux-arm64")
    args = [
        "--fp-config={0}".format(fp_config_path),
        "--fp-license={0}".format(license_token),
        "--user-data-dir={0}".format(user_data_dir),
        "--fp-address-label={0}".format(label),
        "--remote-debugging-port={0}".format(cdp_port),
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--lang={0}".format(language),
    ]

    if is_linux:
        # Linux/Docker only: the GPU strings come from fp-config, so software
        # rendering costs nothing here. macOS needs none of this and disabling
        # its sandbox would be a pure security downgrade.
        args += [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-crash-reporter",
            # Avoids a startup abort in the Linux builds.
            "--no-zygote",
        ]

    if is_win and headless:
        # Not --headless=new: real headless has its own detectable fingerprint.
        args += ["--window-position=-10000,-10000", "--window-size=1,1"]

    if platform == "darwin":
        # macOS only: ICU on macOS resolves Intl.* (locale, month names,
        # display names, etc.) from CFLocale/AppleLanguages, not from --lang
        # or the POSIX LANG/LC_ALL environment - those are silently ignored by
        # the system ICU build the kernel links against. This NSUserDefaults
        # argv pair is the only thing that actually steers it, which is why it
        # is only meaningful on darwin; on Windows/Linux it would just be an
        # unrecognised argument.
        #
        # The "(xx-XX)" half has no leading dash, so Chromium's own parser takes
        # it for a positional argument and opens it as a URL in a stray tab;
        # browser.py closes that tab after connecting, at the cost of it being
        # briefly visible.
        #
        # `--no-startup-window` would stop the tab from ever existing, and it was
        # tried: it also defers session restore, so Chromium restores the
        # profile's previous tabs into a window of its own beside the one created
        # over CDP, and every existing profile opens with two windows. Kernels
        # carrying the mac-locale patch read the locale from fp-config, which
        # retires the pair entirely.
        args += ["-AppleLanguages", "({0})".format(language)]

    # The passkey store sits at the profile root, outside --user-data-dir, so an
    # export or a cloud sync can carry it to another machine.
    root = Path(profile_dir) if profile_dir else Path(user_data_dir)
    args.append("--fp-webauthn-store={0}".format(root / PASSKEYS_ENTRY))
    if webauthn_capture is False:
        args.append("--fp-webauthn-create=choose")

    args += proxy_args(proxy, profile_dir=profile_dir or user_data_dir, mode=proxy_auth)

    if extra_args:
        args += list(extra_args)
    return args


def is_stray_locale_tab_url(url: str, language: str) -> bool:
    """True for the tab Chromium opens because of ``-AppleLanguages (xx-XX)``.

    Chromium's URL fixup turns the bare ``(en-US)`` positional argument into
    ``http://(en-us)/`` (confirmed against a real build), so match that shape as
    well as the raw argument.
    """
    decoded = urllib.parse.unquote(url or "").strip()
    return bool(re.fullmatch(r"(?:https?://)?\({0}\)/?".format(re.escape(language)), decoded, re.IGNORECASE))


def spawn_kernel(exe_path: Path | str, args: Sequence[str]) -> subprocess.Popen:
    """Start the kernel process with piped output.

    On POSIX the child becomes its own process-group leader so the whole group
    (renderers, GPU process, zygote) can be killed in one signal.
    """
    popen_kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
    }
    if sys.platform.startswith("win"):
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        popen_kwargs["start_new_session"] = True
    return subprocess.Popen([str(exe_path)] + list(args), **popen_kwargs)


def _drain_output(process: subprocess.Popen, sink: List[str]) -> None:
    """Collect the tail of the kernel's output on a daemon thread.

    Worth the thread: the kernel explains *why* it refused to start (bad
    license, concurrency cap) on stderr and nowhere else.
    """
    import threading

    def pump() -> None:
        stream = process.stdout
        if stream is None:
            return
        try:
            for line in iter(stream.readline, b""):
                sink.append(line.decode("utf-8", "replace"))
                if len(sink) > 200:
                    del sink[:100]
        except (ValueError, OSError):
            pass

    thread = threading.Thread(target=pump, daemon=True, name="antibrow-kernel-output")
    thread.start()


def _probe_cdp(port: int) -> Optional[str]:
    """Return the browser WebSocket URL once /json/version answers."""
    try:
        with urllib.request.urlopen(  # noqa: S310
            "http://127.0.0.1:{0}/json/version".format(port), timeout=1.0
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    endpoint = payload.get("webSocketDebuggerUrl")
    return endpoint or "ws://127.0.0.1:{0}".format(port)


def read_devtools_active_port(user_data_dir: Path | str) -> Optional[str]:
    """Read Chromium's DevToolsActivePort file, when the build writes one.

    The kernel reports its endpoint on stderr instead, so this is a secondary
    source; HTTP polling is the primary one because it is version-agnostic.
    """
    path = Path(user_data_dir) / "DevToolsActivePort"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if not lines:
        return None
    try:
        port = int(lines[0].strip())
    except ValueError:
        return None
    suffix = lines[1].strip() if len(lines) > 1 else ""
    return "ws://127.0.0.1:{0}{1}".format(port, suffix)


def wait_for_cdp(
    process: subprocess.Popen,
    port: int,
    user_data_dir: Path | str,
    timeout: float = DEFAULT_LAUNCH_TIMEOUT,
    output: Optional[List[str]] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> str:
    """Block until the kernel's CDP endpoint answers; return its ws:// URL."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        endpoint = _probe_cdp(port)
        if endpoint:
            if on_progress is not None:
                on_progress("CDP endpoint ready {0}".format(endpoint))
            return endpoint

        exit_code = process.poll()
        if exit_code is not None:
            diagnostics = "".join(output or []).strip()
            if diagnostics and _CONCURRENCY_PATTERN.search(diagnostics):
                cap = re.search(r"limit\s*\((\d+)\)", diagnostics)
                raise ConcurrencyLimitError(
                    "Concurrency limit reached{0}: close a running browser, or upgrade "
                    "your plan for more simultaneous browsers.".format(
                        " ({0})".format(cap.group(1)) if cap else ""
                    )
                )
            if diagnostics and "license" in diagnostics.lower():
                raise LaunchError(
                    "The browser kernel rejected the license token (exit code {0}).\n"
                    "Kernel output:\n{1}".format(exit_code, diagnostics[-2000:])
                )
            raise LaunchError(
                "Browser exited before the CDP endpoint was ready (exit code {0}).{1}".format(
                    exit_code,
                    "\nKernel output:\n{0}".format(diagnostics[-2000:]) if diagnostics else "",
                )
            )

        # Secondary source; HTTP polling is the primary one.
        from_file = read_devtools_active_port(user_data_dir)
        if from_file and _probe_cdp(port):
            return from_file

        time.sleep(0.2)

    diagnostics = "".join(output or []).strip()
    kill_process_tree(process)
    raise LaunchError(
        "Timed out after {0:.0f}s waiting for the CDP endpoint on port {1}.{2}".format(
            timeout, port, "\nKernel output:\n{0}".format(diagnostics[-2000:]) if diagnostics else ""
        )
    )


def kill_process_tree(process: Optional[subprocess.Popen]) -> None:
    """Kill the kernel and every process it spawned."""
    if process is None or process.poll() is not None:
        return
    pid = process.pid
    if sys.platform.startswith("win"):
        try:
            subprocess.run(
                ["taskkill", "/pid", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            process.kill()
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                process.kill()
            except OSError:
                pass
    try:
        process.wait(timeout=10)
    except Exception:
        pass
