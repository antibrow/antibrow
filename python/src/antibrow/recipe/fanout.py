"""One recipe, N isolated identities."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, List, Optional, Sequence, Tuple

from ..license import get_license_token
from .runtime import RecipeRunResult, run_recipe
from .source import RecipeError


@dataclass(frozen=True)
class FanoutRow:
    profile: str
    ok: bool
    result: Optional[RecipeRunResult] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class FanoutResult:
    id: str
    concurrency: int
    rows: Tuple[FanoutRow, ...]

    @property
    def ok(self) -> bool:
        return all(row.ok for row in self.rows)


def fanout_recipe(
    recipe_id: str,
    profiles: Sequence[str],
    *,
    concurrency: Optional[int] = None,
    api_key: Optional[str] = None,
    server: Optional[str] = None,
    cache_dir: Optional[Path] = None,
    notify: Optional[Callable[[str], None]] = None,
    on_row: Optional[Callable[[FanoutRow], None]] = None,
    **run_kwargs: Any,
) -> FanoutResult:
    """Run one recipe on several profiles at once.

    The concurrency cap is read from the license before anything is queued
    rather than discovered by launching into a refusal: the kernel enforces the
    limit machine-wide, so the browser that gets turned away is not necessarily
    one of ours - and a refused launch mid-fanout looks like a broken recipe.
    """
    ordered: List[str] = []
    for name in profiles:
        if name not in ordered:
            ordered.append(name)
    if not ordered:
        raise RecipeError("fanout_recipe needs at least one profile.")

    license_info = get_license_token(api_key, server)
    requested = concurrency if concurrency is not None else license_info.mi
    limit = max(1, min(requested, license_info.mi, len(ordered)))
    if notify is not None and requested > license_info.mi:
        notify(
            "Concurrency lowered to {0}: that is what this plan's license allows, "
            "and the browser enforces it.".format(license_info.mi)
        )

    def one(profile: str) -> FanoutRow:
        try:
            result = run_recipe(
                recipe_id,
                profile=profile,
                temporary=False,
                api_key=api_key,
                server=server,
                cache_dir=cache_dir,
                **run_kwargs,
            )
            row = FanoutRow(profile=profile, ok=True, result=result)
        except Exception as exc:  # noqa: BLE001 - one profile must not take the rest down
            row = FanoutRow(profile=profile, ok=False, error=str(exc))
        if on_row is not None:
            on_row(row)
        return row

    with ThreadPoolExecutor(max_workers=limit) as pool:
        # Mapped in the order asked for, so a caller diffing two profiles'
        # output does not have to sort first.
        rows = tuple(pool.map(one, ordered))
    return FanoutResult(id=recipe_id, concurrency=limit, rows=rows)
