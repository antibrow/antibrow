"""The per-profile encryption key the kernel takes as ``--fp-crypt-key``.

Cookies and saved passwords are encrypted under a key that never touches the
profile directory - the kernel keeps only a verifier there. The key is fetched
per launch and kept in memory only.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from . import config as _config
from .config import encode_path_segment
from .errors import CryptKeyError
from .profile_dir import is_crypt_key_pending, is_profile_encrypted

#: 32 bytes as lowercase hex, the form the kernel's --fp-crypt-key takes.
CRYPT_KEY_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def parse_crypt_key_body(body: Any) -> Optional[str]:
    """``{"cryptKey": null}`` is the server saying this profile has no key, which
    is a usable answer. Anything else unexpected is an error: reporting a
    malformed body as "no key" would launch an encrypted profile without its key.
    """
    if not isinstance(body, dict):
        raise CryptKeyError("Encryption key response was not an object")
    key = body.get("cryptKey")
    if key is None:
        return None
    if not isinstance(key, str) or not CRYPT_KEY_PATTERN.match(key):
        raise CryptKeyError("Encryption key response carried a malformed key")
    return key


def fetch_profile_crypt_key(
    profile_name: str,
    api_key: str,
    server: Optional[str] = None,
) -> Optional[str]:
    """The owner's own key. Guests use the shared endpoint instead."""
    base = (server or _config.default_server()).rstrip("/")
    url = "{0}/api/v1/profiles/{1}/crypt-key".format(base, encode_path_segment(profile_name))
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer {0}".format(api_key),
            "Accept": "application/json",
            # Cloudflare rejects the stdlib default agent outright (error 1010).
            "User-Agent": _config.USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
            raw = response.read().decode("utf8")
    except urllib.error.HTTPError as error:
        raise CryptKeyError(
            "Failed to fetch the encryption key for profile {0!r}: HTTP {1}".format(profile_name, error.code)
        )
    except (urllib.error.URLError, OSError) as error:
        # An encrypted profile cannot launch without this key, so a transport
        # failure here (offline, DNS, connection refused) must not reach the
        # caller as a bare socket error - it needs to name the profile and say
        # that the key is what could not be reached, or the resulting refusal
        # reads as unexplainable instead of "no network, by design".
        raise CryptKeyError(
            "Could not reach the server to fetch the encryption key for profile {0!r} ({1}). "
            "This profile is encrypted and cannot launch without its key.".format(profile_name, error)
        )
    try:
        body = json.loads(raw)
    except ValueError:
        raise CryptKeyError(
            "Encryption key response for profile {0!r} was unreadable".format(profile_name)
        )
    return parse_crypt_key_body(body)


def resolve_crypt_key(
    profile_dir: Path | str,
    *,
    crypt_key: Optional[str] = None,
    get_crypt_key: Optional[Callable[[], Optional[str]]] = None,
) -> Optional[str]:
    """The key this launch must pass, if any.

    The profile directory's own state decides - never whether the server happens
    to hold a key: the kernel binds the key when the profile is created, so a key
    handed to a directory made without one, and a key withheld from one made with
    it, both leave it unlaunchable.

    Two states call for the key. A directory already marked encrypted is bound to
    one. A directory with a pending marker is not bound yet and is asking to be:
    binding happens on the profile's first launch, which is therefore the launch
    that has to carry the flag - the mark cannot be its precondition, because the
    mark is what that launch produces. Call :func:`settle_crypt_state` first so a
    marker the data has already answered is gone by now.
    """
    pending = is_crypt_key_pending(profile_dir)
    if not pending and not is_profile_encrypted(profile_dir):
        return None
    # Any failure below propagates. Launching without the flag is never the
    # fallback: the current kernel refuses to start, and older ones silently
    # destroy the profile's cookies and saved passwords. A pending directory is
    # no softer a case - it may already be bound and simply unable to say so.
    key = crypt_key if crypt_key else (get_crypt_key() if get_crypt_key else None)
    if not key:
        raise CryptKeyError(
            "Profile at {0} {1} an external encryption key, but none could be "
            "obtained. Refusing to launch.".format(
                profile_dir, "is being created under" if pending else "was created with"
            )
        )
    if not CRYPT_KEY_PATTERN.match(key):
        raise CryptKeyError("Refusing to launch with a malformed encryption key")
    return key
