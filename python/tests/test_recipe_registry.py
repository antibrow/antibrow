from __future__ import annotations

import hashlib
import json

import pytest

from antibrow.recipe import registry as reg
from antibrow.recipe.source import RecipeError, entry_from_row

REGISTRY_URL = "https://recipes.test/registry.json"


def source_for(recipe_id: str, domains=("example.com",)) -> str:
    hosts = json.dumps(list(domains)).replace('"', "'")
    return (
        "export const meta = {\n"
        "  id: '" + recipe_id + "',\n"
        "  summary: 'Lists the things.',\n"
        "  domains: " + hosts + ",\n"
        "  entry: 'https://" + domains[0] + "/',\n"
        "  identity: 'any',\n"
        "}\n\n"
        "export async function run(ctx) { return await ctx.fetchJson('/list.json') }\n"
    )


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def row_for(recipe_id: str, source: str, *, reviewed: bool = True, domains=("example.com",)) -> dict:
    return {
        "id": recipe_id,
        "path": "sites/{0}.recipe.js".format(recipe_id),
        "sha256": sha(source),
        "reviewed": reviewed,
        "summary": "Lists the things.",
        "domains": list(domains),
        "entry": "https://{0}/".format(domains[0]),
        "identity": "any",
        "args": [],
    }


@pytest.fixture(autouse=True)
def _registry_url(monkeypatch):
    monkeypatch.setenv(reg.ENV_REGISTRY_URL, REGISTRY_URL)


def serve(monkeypatch, routes):
    def fake_send(method, url, **kwargs):
        body = routes.get(url.split("?")[0])
        return (200, body) if body is not None else (404, "missing")

    monkeypatch.setattr(reg._http, "send", fake_send)


def test_caches_the_registry_and_pins_every_recipe(tmp_path, monkeypatch):
    source = source_for("example/list")
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row_for("example/list", source)]})})

    result = reg.update_recipes(tmp_path)
    assert result.added == ("example/list",)
    assert len(reg.load_cached_registry(tmp_path).recipes) == 1
    assert reg.read_lock(tmp_path)["example/list"] == sha(source)


# The file already ran once against a profile that may hold live logins, so a
# silent swap of its bytes is exactly the shape an attack takes here.
def test_refuses_changed_bytes_until_accepted(tmp_path, monkeypatch):
    first = source_for("example/list")
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row_for("example/list", first)]})})
    reg.update_recipes(tmp_path)

    second = first + "// a later revision\n"
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row_for("example/list", second)]})})
    with pytest.raises(RecipeError, match="changed since this machine pinned them"):
        reg.update_recipes(tmp_path)
    assert reg.read_lock(tmp_path)["example/list"] == sha(first)

    accepted = reg.update_recipes(tmp_path, accept_changes=True)
    assert accepted.changed == ("example/list",)
    assert reg.read_lock(tmp_path)["example/list"] == sha(second)


def test_rejects_a_row_with_no_digest(tmp_path, monkeypatch):
    row = row_for("example/list", source_for("example/list"))
    del row["sha256"]
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row]})})
    with pytest.raises(RecipeError, match="no sha256"):
        reg.update_recipes(tmp_path)


def test_rejects_a_row_declaring_a_wildcard_host(tmp_path, monkeypatch):
    row = row_for("example/list", source_for("example/list"))
    row["domains"] = ["*.example.com"]
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row]})})
    with pytest.raises(RecipeError, match="exact hostnames"):
        reg.update_recipes(tmp_path)


def test_downloads_verifies_and_reuses_the_pinned_bytes(tmp_path, monkeypatch):
    source = source_for("example/list")
    entry = entry_from_row(row_for("example/list", source))
    calls = []

    def fake_send(method, url, **kwargs):
        calls.append(url)
        return 200, source

    monkeypatch.setattr(reg._http, "send", fake_send)
    assert reg.ensure_recipe_source(entry, tmp_path) == source
    assert reg.ensure_recipe_source(entry, tmp_path) == source
    assert len(calls) == 1


def test_refuses_bytes_that_do_not_match_the_digest(tmp_path, monkeypatch):
    entry = entry_from_row(row_for("example/list", source_for("example/list")))
    serve(monkeypatch, {"https://recipes.test/sites/example/list.recipe.js": source_for("example/list") + "// x\n"})
    with pytest.raises(RecipeError, match="sha256 mismatch"):
        reg.ensure_recipe_source(entry, tmp_path)


# The row is what a reviewer read; the file is what runs. A wider allowlist in
# the file than in the row must not be allowed to take effect.
def test_refuses_a_file_whose_declaration_disagrees_with_the_row(tmp_path, monkeypatch):
    source = source_for("example/list", ("example.com", "mail.example.net"))
    row = row_for("example/list", source)
    row["domains"] = ["example.com"]
    entry = entry_from_row(row)
    serve(monkeypatch, {"https://recipes.test/sites/example/list.recipe.js": source})
    with pytest.raises(RecipeError, match="disagree on meta.domains"):
        reg.ensure_recipe_source(entry, tmp_path)


class TestAssertRunnable:
    def entry(self, **over):
        row = row_for("example/list", source_for("example/list"))
        row.update(over)
        return entry_from_row(row)

    def test_reviewed_runs_anywhere(self, tmp_path):
        reg.assert_runnable(self.entry(), temporary=False, cache_dir=tmp_path)

    def test_unreviewed_needs_an_explicit_opt_in(self, tmp_path):
        with pytest.raises(RecipeError, match="has not been reviewed"):
            reg.assert_runnable(self.entry(reviewed=False), temporary=True, cache_dir=tmp_path)

    # A temporary profile is local-only, so nothing an unreviewed recipe touches
    # travels to another machine.
    def test_unreviewed_is_confined_to_a_temporary_profile(self, tmp_path):
        with pytest.raises(RecipeError, match="only run on a temporary profile"):
            reg.assert_runnable(
                self.entry(reviewed=False), temporary=False, allow_unreviewed=True, cache_dir=tmp_path
            )
        reg.assert_runnable(
            self.entry(reviewed=False), temporary=True, allow_unreviewed=True, cache_dir=tmp_path
        )

    def test_refuses_a_recipe_that_drifted_from_the_pin(self, tmp_path, monkeypatch):
        source = source_for("example/list")
        serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": [row_for("example/list", source)]})})
        reg.update_recipes(tmp_path)
        with pytest.raises(RecipeError, match="changed since it was pinned"):
            reg.assert_runnable(self.entry(sha256=sha(source + "// other\n")), temporary=False, cache_dir=tmp_path)


def test_unknown_id_names_the_other_commands_for_that_site(tmp_path, monkeypatch):
    rows = [row_for("example/list", source_for("example/list")), row_for("example/search", source_for("example/search"))]
    serve(monkeypatch, {REGISTRY_URL: json.dumps({"version": 1, "recipes": rows})})
    registry = reg.update_recipes(tmp_path).registry
    with pytest.raises(RecipeError, match="example/list, example/search"):
        registry.find("example/lists")
