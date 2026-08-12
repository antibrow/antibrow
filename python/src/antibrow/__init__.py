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

__version__ = "0.8.0"

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
    TEMPORARY_PROFILES_DIR_NAME,
    config_dir,
    default_cache_dir,
    default_server,
    list_profiles,
    profile_dir,
    profiles_dir,
)
from .devices import fetch_real_device
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
    ANDROID_MIN_KERNEL_VERSION,
    KERNEL_MANIFEST_URL,
    KERNEL_VERSIONS,
    KernelUpdateStatus,
    KernelVersion,
    android_capable_kernels,
    current_platform,
    default_kernel_version,
    delete_kernel,
    ensure_kernel,
    find_kernel_version,
    find_kernel_version_strict,
    installed_kernel_updates,
    is_kernel_installed,
    kernel_dir,
    kernel_dir_size,
    kernel_supports_android,
    kernel_version_at_least,
    kernels_for_platform,
    list_installed_kernels,
    load_cached_kernel_versions,
    migrate_legacy_kernel_dirs,
    normalize_kernel_version,
    refresh_kernel_catalogue,
    refresh_kernel_versions,
    resolve_android_kernel,
)
from .license import LicenseInfo, fetch_license_token, get_license_token
from .persona import (
    DeviceType,
    Persona,
    generate_persona,
    load_or_generate_persona,
    persona_to_fp_config,
    read_persona,
)
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
from .profile_sync import (
    ArchiveUrls,
    ensure_server_profile,
    get_profile_archive_upload_url,
    get_profile_archive_urls,
)
from .proxy import ProxySpec, parse_proxy
from .temporary_profiles import (
    ClearedTemporaryProfile,
    clear_temporary_profiles,
    temporary_profile_last_used,
)

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
    "find_kernel_version_strict",
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
    "normalize_kernel_version",
    "migrate_legacy_kernel_dirs",
    # android device profiles
    "DeviceType",
    "fetch_real_device",
    "kernel_supports_android",
    "android_capable_kernels",
    "resolve_android_kernel",
    "kernel_version_at_least",
    "ANDROID_MIN_KERNEL_VERSION",
    # profiles and identity
    "Persona",
    "generate_persona",
    "load_or_generate_persona",
    "read_persona",
    "persona_to_fp_config",
    "list_profiles",
    "profile_dir",
    "profiles_dir",
    "default_cache_dir",
    "config_dir",
    "default_server",
    "TEMPORARY_PROFILES_DIR_NAME",
    "ClearedTemporaryProfile",
    "clear_temporary_profiles",
    "temporary_profile_last_used",
    # cloud sync and portable archives
    "ArchiveUrls",
    "get_profile_archive_upload_url",
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
