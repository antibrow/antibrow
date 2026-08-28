from __future__ import annotations

import threading
import time

import pytest

from antibrow.license import LicenseInfo
from antibrow.recipe import fanout as fanout_module
from antibrow.recipe.fanout import fanout_recipe
from antibrow.recipe.runtime import RecipeRunResult
from antibrow.recipe.source import RecipeError


@pytest.fixture(autouse=True)
def _license(monkeypatch):
    monkeypatch.setattr(
        fanout_module, "get_license_token", lambda *a, **k: LicenseInfo(token="t", exp=0, mi=4, sync=True)
    )


def _ok(profile: str) -> RecipeRunResult:
    return RecipeRunResult(id="example/list", profile=profile, value={"profile": profile})


def test_runs_the_same_recipe_on_every_profile(monkeypatch):
    monkeypatch.setattr(fanout_module, "run_recipe", lambda rid, **kw: _ok(kw["profile"]))
    result = fanout_recipe("example/list", ["a", "b", "c"])
    assert [row.profile for row in result.rows] == ["a", "b", "c"]
    assert result.ok


# The limit is machine-wide and enforced by the browser, so a fanout that walks
# into it looks like a broken recipe rather than a plan limit.
def test_never_queues_more_browsers_than_the_license_allows(monkeypatch):
    monkeypatch.setattr(
        fanout_module, "get_license_token", lambda *a, **k: LicenseInfo(token="t", exp=0, mi=2, sync=True)
    )
    live = {"now": 0, "peak": 0}
    lock = threading.Lock()

    def slow(rid, **kw):
        with lock:
            live["now"] += 1
            live["peak"] = max(live["peak"], live["now"])
        time.sleep(0.05)
        with lock:
            live["now"] -= 1
        return _ok(kw["profile"])

    monkeypatch.setattr(fanout_module, "run_recipe", slow)
    notices = []
    result = fanout_recipe(
        "example/list", ["a", "b", "c", "d"], concurrency=8, notify=notices.append
    )
    assert live["peak"] == 2
    assert result.concurrency == 2
    assert "lowered to 2" in " ".join(notices)


def test_one_failure_does_not_take_the_rest_down(monkeypatch):
    def flaky(rid, **kw):
        if kw["profile"] == "b":
            raise RuntimeError("site said no")
        return _ok(kw["profile"])

    monkeypatch.setattr(fanout_module, "run_recipe", flaky)
    result = fanout_recipe("example/list", ["a", "b", "c"])
    assert [row.ok for row in result.rows] == [True, False, True]
    assert result.rows[1].error == "site said no"
    assert not result.ok


def test_reports_in_the_order_asked_for(monkeypatch):
    def uneven(rid, **kw):
        time.sleep(0.03 if kw["profile"] == "a" else 0.0)
        return _ok(kw["profile"])

    monkeypatch.setattr(fanout_module, "run_recipe", uneven)
    result = fanout_recipe("example/list", ["a", "b"])
    assert [row.profile for row in result.rows] == ["a", "b"]


def test_deduplicates_the_profile_list(monkeypatch):
    seen = []
    monkeypatch.setattr(
        fanout_module, "run_recipe", lambda rid, **kw: (seen.append(kw["profile"]), _ok(kw["profile"]))[1]
    )
    result = fanout_recipe("example/list", ["a", "a", "b"])
    assert len(result.rows) == 2
    assert seen == ["a", "b"]


def test_refuses_an_empty_profile_list():
    with pytest.raises(RecipeError, match="at least one profile"):
        fanout_recipe("example/list", [])
