"""Task-level site adapters: one command in, structured JSON out.

The recipes themselves live in their own public repository and are shared with
the Node SDK, so a site is added without releasing this package::

    from antibrow.recipe import run_recipe

    result = run_recipe('reddit/hot', temporary=True, args={'limit': 5})
    print(result.value)

The point of doing this here rather than in a single-browser tool is
:func:`fanout_recipe`: the same command on N profiles, each with its own
persona, cookie jar and exit IP.
"""

from .bootstrap import CTX_SOURCE, build_runner_expression, encode_payload, strip_exports
from .fanout import FanoutResult, FanoutRow, fanout_recipe
from .registry import (
    RECIPE_REGISTRY_URL,
    RecipeRegistry,
    UpdateResult,
    assert_runnable,
    ensure_recipe_source,
    load_cached_registry,
    load_registry,
    parse_registry,
    read_lock,
    recipe_lock_path,
    recipes_dir,
    registry_url,
    update_recipes,
)
from .runtime import (
    DEFAULT_RECIPE_TIMEOUT,
    RecipeLaunch,
    RecipeRunResult,
    resolve_published,
    run_recipe,
    run_recipe_async,
    run_recipe_on_page,
    run_recipe_on_page_async,
    run_recipe_source,
    run_recipe_source_async,
    temporary_recipe_profile_name,
)
from .select import apply_filter, parse_filter
from .source import (
    RecipeArg,
    RecipeEntry,
    RecipeError,
    RecipeMeta,
    coerce_args,
    describe,
    entry_from_row,
    extract_declared,
    resolve_entry,
    validate_meta,
)

__all__ = [
    "CTX_SOURCE",
    "DEFAULT_RECIPE_TIMEOUT",
    "RECIPE_REGISTRY_URL",
    "FanoutResult",
    "FanoutRow",
    "RecipeArg",
    "RecipeEntry",
    "RecipeError",
    "RecipeLaunch",
    "RecipeMeta",
    "RecipeRegistry",
    "RecipeRunResult",
    "UpdateResult",
    "apply_filter",
    "assert_runnable",
    "build_runner_expression",
    "coerce_args",
    "encode_payload",
    "describe",
    "ensure_recipe_source",
    "entry_from_row",
    "extract_declared",
    "fanout_recipe",
    "load_cached_registry",
    "load_registry",
    "parse_filter",
    "parse_registry",
    "read_lock",
    "recipe_lock_path",
    "recipes_dir",
    "registry_url",
    "resolve_entry",
    "resolve_published",
    "run_recipe",
    "run_recipe_async",
    "run_recipe_on_page",
    "run_recipe_on_page_async",
    "run_recipe_source",
    "run_recipe_source_async",
    "strip_exports",
    "temporary_recipe_profile_name",
    "update_recipes",
    "validate_meta",
]
