"""A kernel whose owner process died must not outlive it.

The registry is shared with the JS SDK, so the file name, the JSON shape and
the reap rule all have to stay byte-compatible with ``engine/reaper.ts``.
"""

from __future__ import annotations

import json

from antibrow import reaper as R


def test_registry_path_is_shared_with_the_js_sdk(tmp_path):
    assert R.registry_path(tmp_path) == tmp_path / "running-kernels.json"


def test_reaps_a_kernel_whose_owner_is_gone(tmp_path):
    R.register_kernel(
        tmp_path, kernel_pid=4242, owner_pid=999, profile_dir=tmp_path / "p", cdp_port=51234
    )

    killed = []
    reaped = R.reap_orphans(
        tmp_path,
        is_alive=lambda pid: pid == 4242,  # kernel still up, owner long gone
        command_line=lambda pid: "/kernels/152/Chromium --fp-config={0}/p/fp-config.json".format(
            tmp_path
        ),
        kill=killed.append,
    )

    assert killed == [4242]
    assert reaped == [4242]
    assert json.loads(R.registry_path(tmp_path).read_text()) == []


def test_spares_a_kernel_whose_owner_is_still_running(tmp_path):
    R.register_kernel(tmp_path, kernel_pid=4242, owner_pid=999, profile_dir=tmp_path / "p")

    killed = []
    reaped = R.reap_orphans(
        tmp_path, is_alive=lambda pid: True, command_line=lambda pid: str(tmp_path), kill=killed.append
    )

    assert killed == []
    assert reaped == []
    assert len(json.loads(R.registry_path(tmp_path).read_text())) == 1


def test_refuses_to_kill_a_pid_it_cannot_prove_is_the_kernel(tmp_path):
    """A reused pid must survive: argv that never names the profile dir is not ours."""
    R.register_kernel(tmp_path, kernel_pid=4242, owner_pid=999, profile_dir=tmp_path / "p")

    killed = []
    R.reap_orphans(
        tmp_path,
        is_alive=lambda pid: pid == 4242,
        command_line=lambda pid: "/usr/bin/vim notes.txt",
        kill=killed.append,
    )

    assert killed == []


def test_refuses_to_kill_when_the_command_line_is_unreadable(tmp_path):
    R.register_kernel(tmp_path, kernel_pid=4242, owner_pid=999, profile_dir=tmp_path / "p")

    killed = []
    R.reap_orphans(
        tmp_path, is_alive=lambda pid: pid == 4242, command_line=lambda pid: None, kill=killed.append
    )

    assert killed == []


def test_drops_rows_for_kernels_that_are_already_gone(tmp_path):
    R.register_kernel(tmp_path, kernel_pid=4242, owner_pid=999, profile_dir=tmp_path / "p")

    killed = []
    R.reap_orphans(
        tmp_path, is_alive=lambda pid: False, command_line=lambda pid: None, kill=killed.append
    )

    assert killed == []
    assert json.loads(R.registry_path(tmp_path).read_text()) == []


def test_unregister_removes_only_its_own_row(tmp_path):
    R.register_kernel(tmp_path, kernel_pid=1, owner_pid=999, profile_dir=tmp_path / "a")
    R.register_kernel(tmp_path, kernel_pid=2, owner_pid=999, profile_dir=tmp_path / "b")

    R.unregister_kernel(tmp_path, 1)

    assert [e["kernelPid"] for e in json.loads(R.registry_path(tmp_path).read_text())] == [2]


def test_default_kill_reaches_the_real_process_tree_helper():
    """The lazy import in `_kill_tree` must name a function that exists."""
    from antibrow import launcher

    assert callable(launcher.kill_pid_tree)
