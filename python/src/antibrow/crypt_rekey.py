"""The kernel's one-shot re-encryption of a profile directory.

The AntiBrow kernel can move a profile's cookies and saved passwords from one
key to another - including to its own built-in key, which is what makes an
encrypted profile exportable. It runs headless, opens no window and exits when
it is done.

Only the primitives live here. The export that uses them is
:func:`antibrow.portable.export_profile_archive`.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Callable, List, Optional, Sequence

from .errors import CryptRekeyError

#: The kernel's own name for its built-in key (ciphertext tag ``fp1``).
NO_CRYPT_KEY = "none"

#: The code on a :class:`CryptRekeyError` produced by our own timeout, not by a
#: kernel refusal.
REKEY_TIMEOUT_CODE = "TIMEOUT"

# A real conversion is a handful of SQLite rows and finishes in well under a
# second, kernel spawn included; a refusal exits immediately with a code. What
# the bound actually protects against is a kernel that does not understand
# --fp-crypt-rekey-* at all: unknown switches are ignored, so it opens a full
# browser on the temporary copy instead of converting, and without a bound that
# waits forever while holding a licence slot.
DEFAULT_REKEY_TIMEOUT = 60.0

_CODE_PATTERN = re.compile(r"fp-crypt-(?:rekey|key):\s*([A-Z][A-Z0-9_]{2,})\b")

# The conversion runs a kernel, so it takes a licence slot like a launch does.
# LICENSE therefore also means "every slot on this machine is taken", whose fix -
# close a browser - is the opposite of the licence problems it names.
_CODE_HINTS = {
    "LICENSE": (
        "If the licence itself is fine, this means the machine is already running as many "
        "browsers as the plan allows: close one and export again."
    ),
    "IN_USE": "Close this profile's browser and export again.",
    "REKEY_PENDING": (
        "A previous conversion of this profile was interrupted. Open the profile once to "
        "finish it, then export again."
    ),
}

#: What the export hands the conversion step: ``(user_data_dir, from, to)``.
RekeyRunner = Callable[[Path, str, str], None]


def build_rekey_args(
    *,
    user_data_dir: Path | str,
    from_key: str,
    to_key: str,
    license_token: str,
    platform: Optional[str] = None,
) -> List[str]:
    """The conversion command line (without the executable itself).

    ``--fp-crypt-key`` is deliberately absent: passing it alongside these two is
    a parameter error, because then nothing says which key wins.
    """
    args = [
        "--fp-license={0}".format(license_token),
        "--user-data-dir={0}".format(user_data_dir),
        "--fp-crypt-rekey-from={0}".format(from_key),
        "--fp-crypt-rekey-to={0}".format(to_key),
    ]
    if platform in ("linux", "linux-arm64"):
        args += [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-zygote",
        ]
    return args


def parse_rekey_code(output: str) -> Optional[str]:
    """The machine-readable token every kernel refusal carries."""
    found = _CODE_PATTERN.search(output or "")
    return found.group(1) if found else None


def run_crypt_rekey(
    *,
    exe_path: Path | str,
    user_data_dir: Path | str,
    from_key: str,
    to_key: str,
    license_token: str,
    platform: Optional[str] = None,
    timeout: Optional[float] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    extra_args: Optional[Sequence[str]] = None,
) -> str:
    """Convert a profile directory from one encryption scheme to another."""
    args = build_rekey_args(
        user_data_dir=user_data_dir,
        from_key=from_key,
        to_key=to_key,
        license_token=license_token,
        platform=platform,
    )
    if extra_args:
        args += list(extra_args)
    limit = DEFAULT_REKEY_TIMEOUT if timeout is None else timeout
    if on_progress:
        on_progress("Converting the profile encryption")
    try:
        done = subprocess.run(  # noqa: S603
            [str(exe_path)] + args,
            capture_output=True,
            timeout=limit,
        )
    except subprocess.TimeoutExpired as expired:
        # A refusal exits on its own with a code and never lands here, so this
        # branch is exactly "we gave up waiting" - which has to read differently
        # from a refusal, or a bug report cannot tell the two apart.
        output = _decode(expired.stdout) + _decode(expired.stderr)
        raise CryptRekeyError(
            "Profile encryption conversion did not finish within {0} and was stopped. "
            "A real conversion finishes in under a second, so this almost always means the "
            "kernel does not support --fp-crypt-rekey and opened a full browser on the "
            "temporary copy instead of converting it. Update the kernel and export "
            "again.{1}".format(_label(limit), _tail(output)),
            code=REKEY_TIMEOUT_CODE,
            exit_code=None,
            output=output.strip(),
        )
    except OSError as error:
        raise CryptRekeyError(
            "Could not run the browser kernel to convert this profile: {0}".format(error)
        )
    output = (_decode(done.stdout) + _decode(done.stderr)).strip()
    if done.returncode == 0:
        return output
    code = parse_rekey_code(output)
    hint = _CODE_HINTS.get(code or "")
    raise CryptRekeyError(
        "Profile encryption conversion failed ({0}, exit code {1}){2}{3}".format(
            code or "no code",
            done.returncode,
            _tail(output, prefix=": "),
            " " + hint if hint else "",
        ),
        code=code,
        exit_code=done.returncode,
        output=output,
    )


def _decode(raw: Optional[bytes]) -> str:
    return raw.decode("utf8", "replace") if raw else ""


def _label(seconds: float) -> str:
    return "{0:g}s".format(seconds)


def _tail(output: str, prefix: str = " Output so far: ") -> str:
    text = (output or "").strip()
    return "{0}{1}".format(prefix, text[-500:]) if text else ""
