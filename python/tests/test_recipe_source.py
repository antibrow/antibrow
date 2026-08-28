from __future__ import annotations

import pytest

from antibrow.recipe.source import (
    RecipeError,
    coerce_args,
    entry_from_row,
    extract_declared,
    resolve_entry,
    validate_meta,
)

BASE = {
    "id": "example/list",
    "summary": "Lists the things.",
    "domains": ["example.com"],
    "entry": "https://example.com/",
    "identity": "any",
}

SOURCE = """export const meta = {
  id: 'example/list',
  summary: 'Lists the things.',
  domains: ['example.com', 'cdn.example.com'],
  entry: 'https://example.com/',
  identity: 'any',
}

export async function run(ctx, args) {
  const res = await ctx.fetchJson('/list.json')
  return { items: res.items.map((i) => ({ id: i.id })) }
}
"""


def test_lowercases_declared_hosts():
    assert validate_meta(dict(BASE, domains=["Example.COM"])).domains == ("example.com",)


def test_rejects_a_wildcard_host():
    for bad in ("*.example.com", ".example.com"):
        with pytest.raises(RecipeError, match="exact hostnames"):
            validate_meta(dict(BASE, domains=[bad]))


def test_rejects_an_undeclared_entry_host():
    with pytest.raises(RecipeError, match="not in meta.domains"):
        validate_meta(dict(BASE, entry="https://other.com/"))


def test_rejects_a_plaintext_entry():
    with pytest.raises(RecipeError, match="https url"):
        validate_meta(dict(BASE, entry="http://example.com/"))


def test_rejects_an_unknown_identity():
    with pytest.raises(RecipeError, match="meta.identity"):
        validate_meta(dict(BASE, identity="root"))


def test_registry_row_needs_a_digest_and_a_relative_path():
    with pytest.raises(RecipeError, match="no sha256"):
        entry_from_row(dict(BASE, path="sites/example/list.recipe.js"))
    with pytest.raises(RecipeError, match="relative file path"):
        entry_from_row(dict(BASE, path="/etc/passwd", sha256="a" * 64))


# run() bodies routinely build objects with an `id` field of their own, and the
# first match would otherwise win.
def test_reads_the_declaration_out_of_the_file_not_the_body():
    declared = extract_declared(SOURCE)
    assert declared["id"] == "example/list"
    assert declared["entry"] == "https://example.com/"
    assert declared["identity"] == "any"
    assert declared["domains"] == ["example.com", "cdn.example.com"]


# Only `recipe test` reads these (a published recipe's arguments come from the
# registry row), but without them a local run would reject every --args value as
# undeclared and apply no defaults - the same file behaving differently
# depending on which SDK ran it.
def test_reads_the_argument_declarations_for_a_local_working_copy():
    source = SOURCE.replace(
        "  identity: 'any',",
        "  identity: 'any',\n"
        "  args: [\n"
        "    { name: 'query', type: 'string', required: true },\n"
        "    { name: 'limit', type: 'number', default: 25, max: 100 },\n"
        "  ],",
    )
    args = extract_declared(source)["args"]
    assert args == [
        {"name": "query", "type": "string", "required": True},
        {"name": "limit", "type": "number", "default": 25, "max": 100},
    ]
    meta = validate_meta(dict(extract_declared(source), summary="local working copy"))
    assert coerce_args(meta, {"query": "x"}) == {"query": "x", "limit": 25}


def test_a_recipe_with_no_args_declares_none():
    assert extract_declared(SOURCE)["args"] == []


def test_a_file_with_no_declaration_is_an_error_not_a_skipped_check():
    with pytest.raises(RecipeError, match="declares no meta"):
        extract_declared("export async function run() { return 1 }")


# Some sites only render results on a real navigation (Google answers a fetch for
# its own result page with a redirect interstitial), and a recipe cannot navigate
# once it is running.
class TestEntryTemplates:
    templated = dict(
        BASE,
        entry="https://example.com/search?q={query}&n={limit}",
        args=[
            {"name": "query", "type": "string", "required": True},
            {"name": "limit", "type": "number", "default": 10, "max": 50},
        ],
    )

    def test_interpolates_declared_arguments_url_encoded(self):
        meta = validate_meta(self.templated)
        resolved = resolve_entry(meta, coerce_args(meta, {"query": "a b/c&d"}))
        assert resolved == "https://example.com/search?q=a%20b%2Fc%26d&n=10"

    def test_drops_a_placeholder_whose_optional_argument_was_omitted(self):
        meta = validate_meta(
            dict(self.templated, args=[{"name": "query", "type": "string"}] + self.templated["args"][1:])
        )
        assert resolve_entry(meta, coerce_args(meta, {})) == "https://example.com/search?q=&n=10"

    def test_rejects_an_undeclared_placeholder(self):
        with pytest.raises(RecipeError, match="not a declared argument"):
            validate_meta(dict(self.templated, entry="https://example.com/s?q={nope}"))

    # An argument-controlled host would let a caller point a reviewed recipe at
    # any site, with that profile's cookies.
    def test_refuses_to_interpolate_the_host(self):
        with pytest.raises(RecipeError, match="may not interpolate the host"):
            validate_meta(dict(self.templated, entry="https://{query}.example.com/"))

    def test_still_checks_the_host_against_declared_domains(self):
        with pytest.raises(RecipeError, match="not in meta.domains"):
            validate_meta(dict(self.templated, entry="https://other.com/search?q={query}"))


class TestCoerceArgs:
    meta = validate_meta(dict(BASE, args=[{"name": "limit", "type": "number", "default": 10, "max": 50}]))

    def test_fills_defaults(self):
        assert coerce_args(self.meta, {}) == {"limit": 10}

    def test_coerces_a_command_line_string(self):
        assert coerce_args(self.meta, {"limit": "5"}) == {"limit": 5}

    def test_rejects_over_the_cap_instead_of_clamping(self):
        with pytest.raises(RecipeError, match="capped at 50"):
            coerce_args(self.meta, {"limit": 500})

    def test_rejects_an_undeclared_argument(self):
        with pytest.raises(RecipeError, match="unknown argument"):
            coerce_args(self.meta, {"limitt": 5})

    def test_rejects_a_missing_required_argument(self):
        meta = validate_meta(dict(BASE, args=[{"name": "query", "type": "string", "required": True}]))
        with pytest.raises(RecipeError, match="is required"):
            coerce_args(meta, {})
        assert coerce_args(meta, {"query": "x"}) == {"query": "x"}

    def test_whole_numbers_stay_whole(self):
        # A recipe interpolating this into a url must see 25, never 25.0.
        assert coerce_args(self.meta, {"limit": "25"}) == {"limit": 25}
