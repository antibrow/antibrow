import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from antibrow import kernel as _kernel

MAC_ZIP = "https://download.antibrow.com/fp-chromium-150-mac-universal.zip"
MAC_EXE = "Chromium.app/Contents/MacOS/Chromium"


def _version(v):
    for kv in _kernel.KERNEL_VERSIONS:
        if kv.version == v:
            return kv
    raise AssertionError("version {0} not in catalogue".format(v))


def test_darwin_is_a_supported_platform():
    assert "darwin" in _kernel.SUPPORTED_PLATFORMS


def test_150_has_a_mac_build_and_149_does_not():
    assert _version("150.0.7871.182").available_on("darwin") is True
    assert _version("149.0.7827.201").available_on("darwin") is False


def test_mac_asset_points_at_the_universal_zip():
    asset = _version("150.0.7871.182").asset("darwin")
    assert asset.download_url == MAC_ZIP
    assert asset.exe_rel_path == MAC_EXE


def test_exe_path_resolves_inside_the_app_bundle():
    kv = _version("150.0.7871.182")
    path = _kernel.kernel_exe_path("/cache", kv, "darwin")
    # Compare as paths, not strings: this test also runs on Windows CI, where
    # the separator is a backslash and a POSIX-shaped suffix never matches.
    assert path == Path("/cache") / "kernels" / "150.0.7871.182" / MAC_EXE


def test_kernels_for_platform_filters_out_149_on_darwin():
    versions = [kv.version for kv in _kernel.kernels_for_platform("darwin")]
    assert "150.0.7871.182" in versions
    assert "149.0.7827.201" not in versions


def test_manifest_token_mac_universal_maps_to_darwin():
    assert _kernel._MANIFEST_PLATFORM["mac-universal"] == "darwin"


@pytest.mark.skipif(sys.platform != "darwin", reason="darwin only")
def test_current_platform_on_mac():
    assert _kernel.current_platform() == "darwin"


@pytest.mark.skipif(sys.platform != "darwin", reason="darwin only")
def test_ditto_extraction_preserves_symlinks(tmp_path):
    src = tmp_path / "src"
    (src / "Versions" / "150").mkdir(parents=True)
    (src / "Versions" / "150" / "payload").write_text("binary")
    os.symlink("150", src / "Versions" / "Current")
    os.symlink("Versions/Current/payload", src / "payload")

    # Pack exactly the way the kernel is published.
    archive = tmp_path / "bundle.zip"
    subprocess.run(
        ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", str(src), str(archive)],
        check=True,
    )

    dest = tmp_path / "out"
    dest.mkdir()
    _kernel._extract_zip(archive, dest)

    assert (dest / "Versions" / "Current").is_symlink()
    assert os.readlink(dest / "Versions" / "Current") == "150"
    assert (dest / "payload").is_symlink()
    assert (dest / "payload").read_text() == "binary"


@pytest.mark.skipif(sys.platform != "darwin", reason="darwin only")
def test_stdlib_zipfile_would_have_flattened_them(tmp_path):
    """Guards the reason the ditto branch exists at all."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "target").write_text("binary")
    os.symlink("target", src / "link")
    archive = tmp_path / "b.zip"
    subprocess.run(
        ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", str(src), str(archive)],
        check=True,
    )
    dest = tmp_path / "naive"
    dest.mkdir()
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(dest)
    # This is the bug: a regular file whose *content* is the link target.
    assert not (dest / "link").is_symlink()


@pytest.mark.skipif(sys.platform != "darwin", reason="darwin only")
def test_signature_check_rejects_a_tampered_bundle(tmp_path):
    app = tmp_path / "Probe.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (tmp_path / "main.c").write_text("int main(void){return 0;}\n")
    subprocess.run(
        ["clang", "-o", str(app / "Contents" / "MacOS" / "Probe"), str(tmp_path / "main.c")],
        check=True,
    )
    (app / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>'
        "<key>CFBundleExecutable</key><string>Probe</string>"
        "<key>CFBundleIdentifier</key><string>com.antibrow.probe</string>"
        "</dict></plist>\n"
    )
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)], check=True)
    _kernel.verify_darwin_bundle_signature(app)  # must not raise

    (app / "Contents" / "Info.plist").write_text("corrupted")
    with pytest.raises(_kernel.KernelDownloadError):
        _kernel.verify_darwin_bundle_signature(app)
