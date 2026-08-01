"""arm64 is its own ``linux-arm64`` asset key; the manifest spells it ``linuxarm64``."""

from pathlib import Path

from antibrow import kernel as _kernel
from antibrow.launcher import build_launch_args

ARM_ZIP = "https://download.antibrow.com/fp-chromium-150-linuxarm64.zip"
BASELINE = "150.0.7871.182"


def _baseline():
    for kv in _kernel.KERNEL_VERSIONS:
        if kv.version == BASELINE:
            return kv
    raise AssertionError("baseline {0} not in catalogue".format(BASELINE))


def test_linux_arm64_is_a_supported_platform():
    assert "linux-arm64" in _kernel.SUPPORTED_PLATFORMS


def test_baseline_ships_an_arm64_build_distinct_from_x86_64():
    kv = _baseline()
    assert kv.available_on("linux-arm64") is True
    assert kv.asset("linux-arm64").download_url == ARM_ZIP
    assert kv.asset("linux").download_url != ARM_ZIP
    # Same bare binary name as x86_64: the kernel dir layout does not change.
    assert kv.asset("linux-arm64").exe_rel_path == "chrome"
    assert _kernel.kernel_exe_path("/cache", kv, "linux-arm64") == (
        Path("/cache") / "kernels" / BASELINE / "chrome"
    )


def test_manifest_token_linuxarm64_maps_to_linux_arm64():
    assert _kernel._MANIFEST_PLATFORM["linuxarm64"] == "linux-arm64"
    rows = (
        '{"versions":[{"version":"151.0.0.2","label":"Chrome 151",'
        '"platform":"linuxarm64","download_url":"fp-chromium-151-linuxarm64.zip",'
        '"exe_rel_path":"chrome","build":"test"}]}'
    )
    parsed = {kv.version: kv for kv in _kernel.parse_kernel_manifest(rows)}
    kv = parsed["151.0.0.2"]
    assert set(kv.platforms) == {"linux-arm64"}
    assert kv.asset("linux-arm64").build == "test"
    # arm64-only kernel: it must not offer itself to x86_64 linux.
    assert kv.available_on("linux") is False


def test_current_platform_picks_the_arm64_asset_by_machine(monkeypatch):
    monkeypatch.setattr(_kernel.sys, "platform", "linux")
    monkeypatch.setattr(_kernel, "_machine", lambda: "aarch64")
    assert _kernel.current_platform() == "linux-arm64"
    monkeypatch.setattr(_kernel, "_machine", lambda: "x86_64")
    assert _kernel.current_platform() == "linux"


def test_arm64_still_gets_the_container_switches():
    # The sandbox/dev-shm switches are as necessary on arm64 as on x86_64; a
    # separate platform key must not drop them.
    def args_for(platform):
        return build_launch_args(
            fp_config_path=Path("/p/fp-config.json"),
            license_token="tok",
            user_data_dir=Path("/p/user-data"),
            label="p",
            cdp_port=1234,
            language="en-US",
            platform=platform,
        )

    assert args_for("linux-arm64") == args_for("linux")
    assert "--no-sandbox" in args_for("linux-arm64")
