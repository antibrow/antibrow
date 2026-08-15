"""Exception types raised by the antibrow SDK.

Every error the SDK raises on purpose derives from :class:`AntibrowError`, so a
caller can wrap a whole launch in one ``except AntibrowError``.
"""

from __future__ import annotations

from typing import Optional


class AntibrowError(Exception):
    """Base class for every error raised by this package."""


class UnsupportedPlatformError(AntibrowError):
    """The current OS/arch has no kernel build."""


class KernelDownloadError(AntibrowError):
    """The browser kernel could not be downloaded or extracted."""


class LicenseError(AntibrowError):
    """No usable license token could be obtained.

    The kernel refuses to start without a valid ``--fp-license`` token, so this
    is fatal for a launch. See :mod:`antibrow.license` for the resolution order.
    """


class LaunchError(AntibrowError):
    """The kernel process failed to start or never exposed a CDP endpoint."""


class ConcurrencyLimitError(LaunchError):
    """The license's concurrent-instance cap (``mi``) is already in use.

    Enforced by the kernel itself (cross-process file locks), not by this SDK.
    """


class ApiError(AntibrowError):
    """The server refused a management call (:mod:`antibrow.api`).

    ``status`` is the HTTP status, or 0 when the server could not be reached at
    all - worth branching on rather than matching the message, which is meant
    for humans.
    """

    def __init__(self, message: str, *, status: int = 0) -> None:
        super().__init__(message)
        self.status = status

    @classmethod
    def of(cls, status: int, body: str, action: str) -> "ApiError":
        if status == 0:
            return cls("Failed to {0}: the server could not be reached".format(action), status=0)
        detail = body.strip()
        if len(detail) > 400:
            detail = detail[:400] + "..."
        message = "Failed to {0}: HTTP {1}".format(action, status)
        return cls("{0}. {1}".format(message, detail) if detail else message, status=status)


class LiveViewError(AntibrowError):
    """A live view could not be registered or streamed.

    Never fatal to the browsing session itself: ``launch(live_view=True)``
    reports it and carries on, because a browser you cannot watch still works.
    """


class CryptKeyError(AntibrowError):
    """A profile created under an external encryption key cannot get that key.

    Fatal for a launch on purpose: the kernel binds the key when the profile is
    created, so the profile cannot be opened without it. Falling back to a
    keyless launch is never correct - older kernels answered that by discarding
    the data they could not read.
    """


class CryptRekeyError(AntibrowError):
    """The one-shot conversion of a profile's encryption did not succeed.

    ``code`` is the machine-readable token the kernel prints (``FROM_MISMATCH``,
    ``REKEY_PENDING``, ``LICENSE``, ...) or ``"TIMEOUT"`` when this SDK stopped
    waiting; match on it rather than on the prose, which has already changed once
    between builds. ``exit_code`` is None for a timeout.
    """

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        exit_code: Optional[int] = None,
        output: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code
        self.output = output


class ProxyError(AntibrowError):
    """A proxy URL could not be parsed or is not supported by the kernel."""


class ProfileCacheError(AntibrowError):
    """A profile archive could not be transferred, read or written.

    A launch never fails over this: cloud sync is best-effort and the local
    profile directory stays usable either way.
    """
