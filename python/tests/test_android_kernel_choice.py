"""Which kernel a new Android profile is created against."""

import pytest

from antibrow import kernel as K
from antibrow.errors import KernelDownloadError

_MIN = K.ANDROID_MIN_KERNEL_VERSION
_PLAT = K.current_platform()


@pytest.fixture()
def catalogue():
    saved = list(K._registered)
    K._registered.clear()
    yield K._registered
    K._registered[:] = saved


def _publish(version: str, build: str) -> None:
    K.register_kernel_versions([
        K.KernelVersion(
            version=version,
            label="Chrome {0}".format(version.split(".")[0]),
            platforms={_PLAT: K.KernelAsset(
                download_url="https://example.test/{0}.zip".format(version),
                exe_rel_path="chrome",
                build=build,
            )},
        )
    ])


def test_nothing_qualifies_before_the_manifest_is_read(catalogue):
    # The baseline carries a desktop kernel with no build stamp, so a lenient
    # lookup would answer with it - an Android profile frozen onto a kernel with
    # no mobile patches. Failing loudly is the point.
    assert K.android_capable_kernels() == []
    with pytest.raises(KernelDownloadError, match="not in the catalogue"):
        K.resolve_android_kernel()


def test_lists_and_resolves_qualifying_kernels(catalogue):
    _publish(_MIN, "2026-08-07 05:17")
    _publish("152", "2026-09-20 10:00")
    # Same-day rebuild of an older major: fresh stamp, none of the mobile patches.
    _publish("150", "2026-09-20 10:00")

    assert [kv.version for kv in K.android_capable_kernels()] == ["152", _MIN]
    # The floor is not a pin: a profile can be created against 151 while 152 is
    # out, and a new one gets 152 without a code change.
    assert K.resolve_android_kernel(_MIN).version == _MIN
    assert K.resolve_android_kernel().version == "152"
    # An Android profile created before kernels went major-only pins a full
    # version string. It must still resolve to its own kernel rather than being
    # silently upgraded to the newest qualifying one.
    assert K.resolve_android_kernel("151.7.7.7").version == _MIN
    # A version that cannot run Android never wins, however explicitly it is asked for.
    assert K.resolve_android_kernel("150.7.7.7").version == "152"
    assert K.resolve_android_kernel("999.0.0.0").version == "152"


def test_ignores_a_version_built_for_another_platform(catalogue):
    other = "linux" if _PLAT == "win32" else "win32"
    K.register_kernel_versions([
        K.KernelVersion(
            version="153",
            label="Chrome 153",
            platforms={other: K.KernelAsset(
                download_url="https://example.test/153.zip",
                exe_rel_path="chrome",
                build="2026-10-01 00:00",
            )},
        )
    ])
    assert [kv.version for kv in K.android_capable_kernels()] == []
