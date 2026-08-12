from pathlib import Path

from antibrow import kernel
from antibrow.kernel import KERNEL_VERSION_CACHE_FILE, migrate_legacy_kernel_dirs


def _make(cache_dir, name, build):
    d = cache_dir / "kernels" / name
    d.mkdir(parents=True)
    (d / ".fp-build").write_text(build, encoding="utf-8")
    (d / "chrome").write_text("binary", encoding="utf-8")
    return d


def _names(cache_dir):
    return sorted(p.name for p in (cache_dir / "kernels").iterdir())


def test_renames_legacy_dir_and_keeps_marker(tmp_path):
    _make(tmp_path, "150.0.0.0", "2026-08-10")
    migrate_legacy_kernel_dirs(tmp_path)
    assert _names(tmp_path) == ["150"]
    assert (tmp_path / "kernels" / "150" / ".fp-build").read_text(encoding="utf-8") == "2026-08-10"
    assert (tmp_path / "kernels" / "150" / "chrome").exists()


def test_drops_legacy_when_major_dir_exists(tmp_path):
    _make(tmp_path, "150", "new")
    _make(tmp_path, "150.0.0.0", "old")
    migrate_legacy_kernel_dirs(tmp_path)
    assert _names(tmp_path) == ["150"]
    assert (tmp_path / "kernels" / "150" / ".fp-build").read_text(encoding="utf-8") == "new"


def test_keeps_newest_of_several_legacy_dirs(tmp_path):
    # Tails 9 and 10 so numeric and string order disagree: sorted as text,
    # "150.0.0.9" wins and the older build is the one that survives.
    _make(tmp_path, "150.0.0.9", "older")
    _make(tmp_path, "150.0.0.10", "newer")
    migrate_legacy_kernel_dirs(tmp_path)
    assert _names(tmp_path) == ["150"]
    assert (tmp_path / "kernels" / "150" / ".fp-build").read_text(encoding="utf-8") == "newer"


def test_a_failed_rename_deletes_nothing(tmp_path, monkeypatch):
    # The one invariant of a migration that moves 190-320MB: a rename it could
    # not perform must never be followed by a delete, or the only copy is gone
    # and an offline machine has no kernel at all.
    _make(tmp_path, "150.0.0.9", "older")
    _make(tmp_path, "150.0.0.10", "newer")

    def boom(self, target):
        raise OSError("locked")

    removed = []
    monkeypatch.setattr(Path, "rename", boom)
    monkeypatch.setattr(kernel.shutil, "rmtree", lambda p, **kw: removed.append(p))

    migrate_legacy_kernel_dirs(tmp_path)

    assert removed == []
    assert _names(tmp_path) == ["150.0.0.10", "150.0.0.9"]


def test_each_major_independently_and_idempotent(tmp_path):
    _make(tmp_path, "149.0.0.0", "a")
    _make(tmp_path, "151.0.0.0", "b")
    migrate_legacy_kernel_dirs(tmp_path)
    migrate_legacy_kernel_dirs(tmp_path)
    assert _names(tmp_path) == ["149", "151"]


def test_no_kernels_dir_is_fine(tmp_path):
    migrate_legacy_kernel_dirs(tmp_path)


def test_leaves_the_old_shared_cache_file(tmp_path):
    legacy = tmp_path / "kernel-versions-cache.json"
    legacy.write_text("[]", encoding="utf-8")
    migrate_legacy_kernel_dirs(tmp_path)
    assert legacy.exists()
    assert KERNEL_VERSION_CACHE_FILE == "kernel-catalog-cache.json"
