from __future__ import annotations

import hashlib
import json

import pytest

from antibrow.cli import main
from antibrow.recipe import registry as reg

REGISTRY_URL = "https://recipes.test/registry.json"

SOURCE = (
    "export const meta = {\n"
    "  id: 'example/list',\n"
    "  summary: 'Lists the things.',\n"
    "  domains: ['example.com'],\n"
    "  entry: 'https://example.com/',\n"
    "  identity: 'any',\n"
    "}\n\n"
    "export async function run(ctx) { return await ctx.fetchJson('/list.json') }\n"
)


def _registry() -> str:
    return json.dumps(
        {
            "version": 1,
            "recipes": [
                {
                    "id": "example/list",
                    "path": "sites/example/list.recipe.js",
                    "sha256": hashlib.sha256(SOURCE.encode("utf-8")).hexdigest(),
                    "reviewed": True,
                    "summary": "Lists the things.",
                    "domains": ["example.com"],
                    "entry": "https://example.com/",
                    "identity": "any",
                    "args": [{"name": "limit", "type": "number", "default": 10, "max": 50}],
                },
                {
                    "id": "other/thing",
                    "path": "sites/other/thing.recipe.js",
                    "sha256": hashlib.sha256(b"x").hexdigest(),
                    "reviewed": False,
                    "summary": "Does the other thing.",
                    "domains": ["other.test"],
                    "entry": "https://other.test/",
                    "identity": "anonymous",
                    "args": [],
                },
            ],
        }
    )


@pytest.fixture(autouse=True)
def _served(monkeypatch):
    monkeypatch.setenv(reg.ENV_REGISTRY_URL, REGISTRY_URL)
    routes = {REGISTRY_URL: _registry(), "https://recipes.test/GUIDE.md": "# Writing a recipe"}

    def fake_send(method, url, **kwargs):
        body = routes.get(url.split("?")[0])
        return (200, body) if body is not None else (404, "missing")

    from antibrow import _http as top_http

    monkeypatch.setattr(top_http, "send", fake_send)


def run(args, tmp_path):
    return main(list(args) + ["--cache-dir", str(tmp_path)])


def test_update_reports_what_it_pinned(tmp_path, capsys):
    assert run(["recipe", "update"], tmp_path) == 0
    out = capsys.readouterr().out
    assert "2 recipe(s) from https://recipes.test/registry.json" in out
    assert "new: example/list, other/thing" in out


def test_list_marks_what_nobody_reviewed(tmp_path, capsys):
    assert run(["recipe", "list"], tmp_path) == 0
    out = capsys.readouterr().out
    assert "example/list" in out
    assert "! Does the other thing." in out


def test_list_filters_by_site(tmp_path, capsys):
    assert run(["recipe", "list", "--site", "example", "--json"], tmp_path) == 0
    assert len(json.loads(capsys.readouterr().out)) == 1

    assert run(["recipe", "list", "--site", "nope"], tmp_path) == 1
    assert "no recipes for site" in capsys.readouterr().err


def test_info_is_self_describing(tmp_path, capsys):
    assert run(["recipe", "info", "example/list"], tmp_path) == 0
    out = capsys.readouterr().out
    assert "entry     https://example.com/" in out
    assert "domains   example.com" in out
    assert "identity  any" in out
    assert "default 10" in out
    assert "max 50" in out


def test_info_points_at_the_other_commands_for_that_site(tmp_path, capsys):
    assert run(["recipe", "info", "example/lists"], tmp_path) == 1
    assert "example/list" in capsys.readouterr().err


def test_guide_prints_and_caches(tmp_path, capsys):
    assert run(["recipe", "guide"], tmp_path) == 0
    assert "# Writing a recipe" in capsys.readouterr().out
    assert (tmp_path / "recipes" / "GUIDE.md").exists()


def test_scaffold_writes_where_the_registry_expects_it(tmp_path, capsys):
    assert run(["recipe", "scaffold", "newsite/list", "--dir", str(tmp_path)], tmp_path) == 0
    written = tmp_path / "sites" / "newsite" / "list.recipe.js"
    assert "id: 'newsite/list'" in written.read_text(encoding="utf-8")
    capsys.readouterr()
    assert run(["recipe", "scaffold", "newsite/list", "--dir", str(tmp_path)], tmp_path) == 1


# Silently running the published recipe instead of the working copy would make a
# local edit look like it took effect when it never ran.
def test_test_refuses_a_target_with_no_local_file(tmp_path, capsys):
    assert run(["recipe", "test", "example/list", "--dir", str(tmp_path)], tmp_path) == 1
    assert "no local recipe" in capsys.readouterr().err


def test_fanout_needs_profiles(tmp_path, capsys):
    assert run(["recipe", "fanout", "example/list"], tmp_path) == 1
    assert "--profiles" in capsys.readouterr().err


def test_bad_args_json_is_reported_not_raised(tmp_path, capsys):
    assert run(["recipe", "run", "example/list", "--temporary", "--args", "{oops"], tmp_path) == 1
    assert "must be a JSON object" in capsys.readouterr().err


def test_recipe_without_a_subcommand_prints_help(capsys):
    assert main(["recipe"]) == 0
    out = capsys.readouterr().out
    for command in ("update", "list", "info", "run", "fanout", "test", "scaffold", "guide"):
        assert command in out
