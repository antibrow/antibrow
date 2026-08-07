"""AntiBrow - the antidetect browser your AI agent can drive.

Kernel-level fingerprint spoofing, unlimited local profiles, and the plain
Playwright API you already write::

    from antibrow import launch

    browser = launch()
    page = browser.new_page()
    page.goto("https://example.com")
    browser.close()

Fingerprints are spoofed inside a custom Chromium build (C++/Blink), not with
JavaScript patches that anti-bot vendors flag on sight, and every signal -
Canvas, WebGL, WebGPU, fonts, audio, ``navigator``, screen, timezone - comes
from one coherent persona that is frozen per profile.

See https://antibrow.com and the project README for the full API.
"""

from __future__ import annotations

__version__ = "0.5.0"

from .browser import (
    Antibrow,
    ArchivePlan,
    AsyncAntibrow,
    LaunchPlan,
    SyncEvent,
    launch,
    launch_async,
    launch_persistent_context,
    launch_persistent_context_async,
    prepare_launch,
)
from .config import (
    config_dir,
    default_cache_dir,
    default_server,
    list_profiles,
    profile_dir,
    profiles_dir,
)
from .errors import (
    AntibrowError,
    ConcurrencyLimitError,
    KernelDownloadError,
    LaunchError,
    LicenseError,
    ProfileCacheError,
    ProxyError,
    UnsupportedPlatformError,
)
from .geoip import ProxyGeo, lookup_proxy_geo
from .kernel import (
    KERNEL_MANIFEST_URL,
    KERNEL_VERSIONS,
    KernelUpdateStatus,
    KernelVersion,
    current_platform,
    default_kernel_version,
    delete_kernel,
    ensure_kernel,
    find_kernel_version,
    installed_kernel_updates,
    is_kernel_installed,
    kernel_dir,
    kernel_dir_size,
    kernels_for_platform,
    list_installed_kernels,
    load_cached_kernel_versions,
    refresh_kernel_catalogue,
    refresh_kernel_versions,
)
from .license import LicenseInfo, fetch_license_token, get_license_token
from .persona import Persona, generate_persona, load_or_generate_persona, persona_to_fp_config
from .portable import (
    PROFILE_ARCHIVE_EXT,
    ImportedProfileMeta,
    PortableProfileMeta,
    export_profile_archive,
    import_profile_archive,
)
from .profile_cache import (
    download_profile_cache,
    pack_profile_cache,
    unpack_profile_cache,
    upload_profile_cache,
)
from .profile_sync import ArchiveUrls, ensure_server_profile, get_profile_archive_urls
from .proxy import ProxySpec, parse_proxy

__all__ = [
    "__version__",
    # launching
    "launch",
    "launch_async",
    "launch_persistent_context",
    "launch_persistent_context_async",
    "prepare_launch",
    "Antibrow",
    "AsyncAntibrow",
    "LaunchPlan",
    "ArchivePlan",
    "SyncEvent",
    # kernels
    "KERNEL_VERSIONS",
    "KERNEL_MANIFEST_URL",
    "KernelVersion",
    "KernelUpdateStatus",
    "current_platform",
    "default_kernel_version",
    "find_kernel_version",
    "kernels_for_platform",
    "ensure_kernel",
    "is_kernel_installed",
    "list_installed_kernels",
    "installed_kernel_updates",
    "refresh_kernel_catalogue",
    "refresh_kernel_versions",
    "load_cached_kernel_versions",
    "kernel_dir",
    "kernel_dir_size",
    "delete_kernel",
    # profiles and identity
    "Persona",
    "generate_persona",
    "load_or_generate_persona",
    "persona_to_fp_config",
    "list_profiles",
    "profile_dir",
    "profiles_dir",
    "default_cache_dir",
    "config_dir",
    "default_server",
    # cloud sync and portable archives
    "ArchiveUrls",
    "get_profile_archive_urls",
    "ensure_server_profile",
    "pack_profile_cache",
    "unpack_profile_cache",
    "download_profile_cache",
    "upload_profile_cache",
    "PROFILE_ARCHIVE_EXT",
    "PortableProfileMeta",
    "ImportedProfileMeta",
    "export_profile_archive",
    "import_profile_archive",
    # proxies and geo
    "ProxySpec",
    "parse_proxy",
    "ProxyGeo",
    "lookup_proxy_geo",
    # licensing
    "LicenseInfo",
    "get_license_token",
    "fetch_license_token",
    # errors
    "AntibrowError",
    "LaunchError",
    "LicenseError",
    "ConcurrencyLimitError",
    "KernelDownloadError",
    "ProfileCacheError",
    "ProxyError",
    "UnsupportedPlatformError",
]
