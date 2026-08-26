"""`timeout` has to be a budget for the whole launch, not just the last step.

Everything blocking used to sit in `prepare_launch`, outside the only timeout
the caller could set: a wedged proxy or an unanswering API meant a hang with no
upper bound and no clue which step it happened in.
"""

from __future__ import annotations

import pytest

from antibrow.deadline import Deadline
from antibrow.errors import LaunchTimeout


def test_no_total_means_no_limit():
    d = Deadline(None)

    assert d.remaining() == float("inf")
    assert d.budget(20.0) == 20.0
    d.check("license")  # must not raise


def test_budget_is_capped_by_what_is_left():
    clock = iter([0.0, 5.0]).__next__
    d = Deadline(8.0, clock=clock)

    assert d.budget(20.0) == pytest.approx(3.0)


def test_a_step_shorter_than_the_remaining_budget_keeps_its_own_timeout():
    clock = iter([0.0, 1.0]).__next__
    d = Deadline(120.0, clock=clock)

    assert d.budget(20.0) == 20.0


def test_check_names_the_step_it_ran_out_on():
    clock = iter([0.0, 130.0]).__next__
    d = Deadline(120.0, clock=clock)

    with pytest.raises(LaunchTimeout) as caught:
        d.check("restoring cloud archive")

    assert caught.value.step == "restoring cloud archive"
    assert "restoring cloud archive" in str(caught.value)
    assert "120" in str(caught.value)


def test_budget_raises_rather_than_handing_out_a_zero_timeout():
    """A zero socket timeout is a non-blocking socket, not an instant failure."""
    clock = iter([0.0, 130.0]).__next__
    d = Deadline(120.0, clock=clock, step="obtaining license token")

    with pytest.raises(LaunchTimeout) as caught:
        d.budget(20.0)

    assert caught.value.step == "obtaining license token"


def test_the_current_step_is_remembered_for_whoever_times_out_next():
    clock = iter([0.0, 0.0, 130.0]).__next__
    d = Deadline(120.0, clock=clock)
    d.check("connecting to the proxy")

    with pytest.raises(LaunchTimeout) as caught:
        d.check(None)

    assert caught.value.step == "connecting to the proxy"


def test_launch_timeout_is_catchable_as_a_launch_error():
    from antibrow.errors import LaunchError

    assert issubclass(LaunchTimeout, LaunchError)


def test_a_paused_stretch_does_not_spend_the_budget():
    """A first kernel install is legitimately gigabytes; it cannot eat the budget."""
    ticks = iter([0.0, 1.0, 601.0, 601.0, 602.0])
    d = Deadline(120.0, clock=lambda: next(ticks))

    with d.paused():  # 600s of downloading
        pass
    d.check("connecting to CDP")  # must not raise

    assert d.remaining() == pytest.approx(118.0)


def test_pause_still_reports_the_budget_spent_before_it():
    ticks = iter([0.0, 100.0, 700.0, 700.0])
    d = Deadline(120.0, clock=lambda: next(ticks))

    with d.paused():
        pass

    assert d.remaining() == pytest.approx(20.0)


def test_pause_releases_even_when_the_step_inside_it_raises():
    ticks = iter([0.0, 1.0, 601.0, 601.0])
    d = Deadline(120.0, clock=lambda: next(ticks))

    with pytest.raises(ValueError):
        with d.paused():
            raise ValueError("download failed")

    assert d.remaining() == pytest.approx(119.0)


# --- the budget has to actually reach `prepare_launch` -----------------------


def _expired(step=None):
    """A deadline whose budget ran out before the first step."""
    return Deadline(120.0, clock=iter([0.0] + [130.0] * 40).__next__, step=step)


def test_prepare_launch_stops_on_an_exhausted_budget_before_any_network_call(
    tmp_path, monkeypatch
):
    from antibrow import browser as B

    monkeypatch.setattr(
        B, "get_license_token", lambda *a, **k: pytest.fail("budget was already spent")
    )

    with pytest.raises(LaunchTimeout) as caught:
        B.prepare_launch("demo", cache_dir=tmp_path, deadline=_expired())

    assert caught.value.step == "obtaining license token"


def test_launch_passes_its_timeout_down_as_the_total_budget(tmp_path, monkeypatch):
    """`timeout=` used to cover only spawn+CDP; it has to cover preparation too."""
    from antibrow import browser as B

    seen = {}

    def prepare(profile, **kwargs):
        seen["deadline"] = kwargs.get("deadline")
        raise RuntimeError("stop here")

    monkeypatch.setattr(B, "prepare_launch", prepare)

    with pytest.raises(RuntimeError):
        B.launch("demo", cache_dir=tmp_path, timeout=42.0)

    assert isinstance(seen["deadline"], Deadline)
    assert seen["deadline"].total == 42.0


def test_launch_timeout_is_importable_from_the_package_root():
    """The CHANGELOG names it; a symbol only reachable via a submodule is not public."""
    import antibrow

    assert antibrow.LaunchTimeout is LaunchTimeout
    assert "LaunchTimeout" in antibrow.__all__
