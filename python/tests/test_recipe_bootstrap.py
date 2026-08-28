"""One recipe has to produce the same output from either SDK.

Both SDKs embed the recipe in one expression the debugger protocol evaluates, so
the two copies of that expression must be byte-identical - a drift here is a
recipe that returns different data depending on which SDK ran it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from antibrow.recipe.bootstrap import (
    CTX_SOURCE,
    build_runner_expression,
    encode_payload,
    strip_exports,
)

JS_BOOTSTRAP = Path(__file__).resolve().parents[2] / "js" / "src" / "recipe" / "bootstrap.ts"

SAMPLE = "export const meta = { id: 'a/b' }\nexport async function run(ctx, args) { return 1 }\n"


PAYLOAD = {"args": {"limit": 7}, "profileName": "p1", "timeoutMs": 60000}


def _js_parts() -> tuple:
    text = JS_BOOTSTRAP.read_text(encoding="utf-8")
    ctx = re.search(r"export const CTX_SOURCE = `(.*?)`\n", text, re.S)
    template = re.search(r"return `(\(async \(\) => \{.*?)`\n\}", text, re.S)
    assert ctx and template, "the Node bootstrap no longer has the shapes this test reads"
    return ctx.group(1), template.group(1)


needs_js = pytest.mark.skipif(not JS_BOOTSTRAP.exists(), reason="Node SDK tree not present")


@needs_js
def test_ctx_surface_is_identical_to_the_node_sdk():
    js_ctx, _ = _js_parts()
    assert CTX_SOURCE == js_ctx


@needs_js
def test_whole_runner_expression_is_identical_to_the_node_sdk():
    js_ctx, template = _js_parts()
    stripped = re.sub(
        r"^[ \t]*export\s+(?=(?:const|let|var|async|function|class)\b)", "", SAMPLE, flags=re.M
    )
    js = (
        template.replace("${encodePayload(payload)}", encode_payload(PAYLOAD))
        .replace("${CTX_SOURCE}", js_ctx)
        .replace("${stripExports(source)}", stripped)
    )
    assert build_runner_expression(SAMPLE, PAYLOAD) == js


def test_strips_only_the_two_allowed_exports():
    stripped = strip_exports(SAMPLE)
    assert "const meta" in stripped
    assert "async function run" in stripped
    assert "export" not in stripped


def test_runner_declares_the_deadline_and_the_closure():
    expression = build_runner_expression(SAMPLE, PAYLOAD)
    # The deadline is enforced in the page because the synchronous Playwright
    # API has nothing to race an evaluation against.
    assert "recipe timed out after" in expression
    assert "__abmod" in expression and "__abctx" in expression


# Playwright drops the `arg` for a string page function, so the payload has to
# travel inside the expression or the recipe runs with no arguments and returns
# nothing.
def test_payload_travels_inside_the_expression():
    expression = build_runner_expression(SAMPLE, PAYLOAD)
    assert 'const payload = {"args":{"limit":7},"profileName":"p1","timeoutMs":60000}' in expression
    assert expression.startswith("(async () => {")
    assert expression.endswith("})()")


def test_payload_encoding_matches_json_stringify():
    # Compact separators, no ASCII escaping - otherwise the two SDKs build
    # different expressions for the same recipe.
    assert encode_payload({"a": 1, "b": "ключ"}) == '{"a":1,"b":"ключ"}'
