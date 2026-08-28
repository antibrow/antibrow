"""The enforcement, exercised without a kernel: it is the part that has to hold."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from antibrow.recipe.runtime import run_recipe_on_page
from antibrow.recipe.source import RecipeError, validate_meta

META = validate_meta(
    {
        "id": "example/list",
        "summary": "Lists the things.",
        "domains": ["example.com", "cdn.example.com"],
        "entry": "https://example.com/",
        "identity": "any",
        "args": [{"name": "limit", "type": "number", "default": 10, "max": 50}],
    }
)

SOURCE = "export const meta = {}\nexport async function run(ctx, args) { return args }\n"


class FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = type("Request", (), {"url": url})()
        self.continued = False
        self.aborted: Optional[str] = None

    def continue_(self) -> None:
        self.continued = True

    def abort(self, reason: str = "aborted") -> None:
        self.aborted = reason


class FakePage:
    """Stands in for a page: the expression is recorded, not evaluated as JS."""

    def __init__(
        self,
        value: Any = None,
        raises: Optional[Exception] = None,
        lose_context_times: int = 0,
    ) -> None:
        self.value = value
        self.raises = raises
        self.lose_context_times = lose_context_times
        self.gotos: List[str] = []
        self.payloads: List[Dict[str, Any]] = []
        self.bindings: Dict[str, Any] = {}
        self.expressions: List[str] = []
        self.load_states: List[str] = []

    def wait_for_load_state(self, state: str, **kwargs: Any) -> None:
        self.load_states.append(state)

    def expose_function(self, name: str, callback: Any) -> None:
        self.bindings[name] = callback

    def goto(self, url: str, **kwargs: Any) -> None:
        self.gotos.append(url)

    def evaluate(self, expression: str) -> Any:
        self.expressions.append(expression)
        if len(self.expressions) <= self.lose_context_times:
            raise RuntimeError("Execution context was destroyed, most likely because of a navigation")
        if self.raises is not None:
            raise self.raises
        # Recipes log through a page binding; drive it the way the page would.
        log = self.bindings.get("__antibrowRecipeLog")
        if log is not None:
            log("starting")
        return self.value


class FakeContext:
    def __init__(self) -> None:
        self.guard: Any = None

    def route(self, pattern: str, handler: Any) -> None:
        self.guard = handler

    def unroute(self, pattern: str, handler: Any) -> None:
        self.guard = None

    def visit(self, url: str) -> FakeRoute:
        route = FakeRoute(url)
        self.guard(route)
        return route


def test_opens_the_entry_and_returns_the_value():
    page = FakePage(value={"items": []})
    context = FakeContext()
    result = run_recipe_on_page(
        META, SOURCE, page=page, context=context, profile_name="shopper-01", args={"limit": "7"}
    )
    assert page.gotos == ["https://example.com/"]
    assert result.value == {"items": []}
    assert result.profile == "shopper-01"
    assert result.logs == ("starting",)
    # Arguments are coerced before they reach the page, and the deadline travels
    # with them because the synchronous API cannot race an evaluation. Both live
    # inside the expression: Playwright drops a separate argument for a string
    # page function.
    assert '"args":{"limit":7}' in page.expressions[0]
    assert '"timeoutMs":60000' in page.expressions[0]


def test_opens_the_entry_with_declared_arguments_interpolated():
    meta = validate_meta(
        {
            "id": "example/search",
            "summary": "Searches the things.",
            "domains": ["example.com"],
            "entry": "https://example.com/search?n={limit}",
            "identity": "any",
            "args": [{"name": "limit", "type": "number", "default": 10, "max": 50}],
        }
    )
    page = FakePage()
    run_recipe_on_page(meta, SOURCE, page=page, context=FakeContext(), profile_name="p", args={"limit": 7})
    assert page.gotos == ["https://example.com/search?n=7"]


# The declaration is only worth anything if it is enforced where the request
# actually leaves: run() executes in the page and can always call fetch itself.
def test_blocks_every_host_the_recipe_did_not_declare():
    page = FakePage(value=None)
    context = FakeContext()

    def evaluate(expression):
        assert context.visit("https://example.com/list.json").continued
        assert context.visit("https://cdn.example.com/app.js").continued
        assert context.visit("https://mail.google.com/inbox").aborted == "blockedbyclient"
        return None

    page.evaluate = evaluate  # type: ignore[method-assign]
    result = run_recipe_on_page(META, SOURCE, page=page, context=context, profile_name="p")
    assert result.blocked_hosts == ("mail.google.com",)


def test_removes_the_guard_when_the_run_ends():
    context = FakeContext()
    run_recipe_on_page(META, SOURCE, page=FakePage(), context=context, profile_name="p")
    assert context.guard is None


# A recipe cannot see its own blocked request, so the failure it reports is
# usually misleading on its own.
def test_names_the_blocked_hosts_when_the_recipe_fails():
    context = FakeContext()
    page = FakePage()

    def evaluate(expression):
        context.visit("https://tracker.example.net/pixel")
        raise RuntimeError("site said no")

    page.evaluate = evaluate  # type: ignore[method-assign]
    with pytest.raises(RecipeError, match=r"site said no \(blocked, not in meta.domains: tracker.example.net\)"):
        run_recipe_on_page(META, SOURCE, page=page, context=context, profile_name="p")


# reddit's entry page bounces once after domcontentloaded, which destroys the
# context the recipe is executing in. That is the page's doing, not the recipe's.
def test_retries_once_when_the_entry_page_navigates_out_from_under_the_recipe():
    page = FakePage(value={"ok": True}, lose_context_times=1)
    result = run_recipe_on_page(META, SOURCE, page=page, context=FakeContext(), profile_name="p")
    assert result.value == {"ok": True}
    assert len(page.expressions) == 2
    assert page.load_states == ["domcontentloaded"]


# An anti-bot interstitial redirects to itself and then to the real page, so the
# context can be lost twice in a row.
def test_tolerates_two_navigations_and_gives_up_after_that():
    twice = FakePage(value={"ok": True}, lose_context_times=2)
    result = run_recipe_on_page(META, SOURCE, page=twice, context=FakeContext(), profile_name="p")
    assert result.value == {"ok": True}
    assert len(twice.expressions) == 3

    forever = FakePage(value={"ok": True}, lose_context_times=9)
    with pytest.raises(RecipeError, match="Execution context was destroyed"):
        run_recipe_on_page(META, SOURCE, page=forever, context=FakeContext(), profile_name="p")
    assert len(forever.expressions) == 3


def test_does_not_retry_an_error_the_recipe_itself_raised():
    page = FakePage(raises=RuntimeError("site said no"))
    with pytest.raises(RecipeError, match="site said no"):
        run_recipe_on_page(META, SOURCE, page=page, context=FakeContext(), profile_name="p")
    assert len(page.expressions) == 1


def test_rejects_an_undeclared_argument_before_opening_anything():
    page = FakePage()
    with pytest.raises(RecipeError, match="unknown argument"):
        run_recipe_on_page(META, SOURCE, page=page, context=FakeContext(), profile_name="p", args={"limitt": 1})
    assert page.gotos == []


def test_a_recipe_with_no_hosts_declared_cannot_be_built():
    with pytest.raises(RecipeError, match="at least one host"):
        validate_meta({**{k: v for k, v in META.__dict__.items() if k != "args"}, "domains": []})
