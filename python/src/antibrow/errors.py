"""Exception types raised by the antibrow SDK.

Every error the SDK raises on purpose derives from :class:`AntibrowError`, so a
caller can wrap a whole launch in one ``except AntibrowError``.
"""

from __future__ import annotations


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


class ProxyError(AntibrowError):
    """A proxy URL could not be parsed or is not supported by the kernel."""
