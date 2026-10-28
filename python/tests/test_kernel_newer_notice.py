from __future__ import annotations

import pytest

from antibrow import browser as B
from antibrow import kernel as K


@pytest.fixture(autouse=True)
def registry():
    saved = list(K._registered)
    K._registered.clear()
    plat = K.current_platform()
    K.register_kernel_versions(
        [
            K.KernelVersion(v, f"Chrome {v}", {plat: K.KernelAsset("https://x/a.zip", "chrome", "2026-10-22")})
            for v in ("196", "197")
        ]
    )
    B._kernel_notices_shown.clear()
    yield
    K._registered[:] = saved
    B._kernel_notices_shown.clear()


def install(cache_dir, version, build):
    path = K.kernel_exe_path(cache_dir, K.find_kernel_version(version))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ")
    K.write_installed_kernel_build(cache_dir, version, build)


def test_nothing_newer_than_the_newest_kernel_on_its_latest_build(tmp_path):
    install(tmp_path, "197", "2026-10-22")
    assert K.newer_kernel_than(tmp_path, "197") == K.NewerKernel()


def test_a_newer_build_of_the_installed_version(tmp_path):
    install(tmp_path, "197", "2026-10-14")
    assert K.newer_kernel_than(tmp_path, "197") == K.NewerKernel(build=("2026-10-14", "2026-10-22"))


def test_a_newer_version_even_when_this_one_is_not_installed(tmp_path):
    assert K.newer_kernel_than(tmp_path, "196") == K.NewerKernel(version="197")


def test_each_finding_is_said_once_per_process(tmp_path):
    install(tmp_path, "196", "2026-10-01")
    seen = []
    kv = K.find_kernel_version("196")
    B._notice_newer_kernel(tmp_path, kv, False, seen.append)
    B._notice_newer_kernel(tmp_path, kv, False, seen.append)
    assert len(seen) == 2
    assert "update_kernel=True" in seen[0]
    assert "Chrome 197 is available" in seen[1]


def test_no_build_notice_when_the_launch_updates_anyway(tmp_path):
    install(tmp_path, "197", "2026-09-01")
    seen = []
    B._notice_newer_kernel(tmp_path, K.find_kernel_version("197"), True, seen.append)
    assert seen == []


def test_without_a_callback_it_goes_to_stderr_not_stdout(tmp_path, capsys):
    install(tmp_path, "197", "2026-09-01")
    B._notice_newer_kernel(tmp_path, K.find_kernel_version("197"), False, None)
    out, err = capsys.readouterr()
    assert out == ""
    assert "[antibrow] A newer build of kernel Chrome 197" in err
