"""A deliberately small subset of jq.

Lets an agent ask for the two fields it needs instead of reading a whole result
into its context::

    .            .items       .items[]      .items[0]     .items[1:3]
    .a.b.c       ["odd key"]  length        keys
    any of the above joined with |

Anything else is rejected by name rather than approximated: a filter that
quietly returns null reads exactly like a site that returned nothing.
"""

from __future__ import annotations

import re
from typing import Any, List, Sequence, Tuple

from .source import RecipeError

_KEY_RE = re.compile(r"^\.([A-Za-z_][A-Za-z0-9_]*)")
_QUOTED_RE = re.compile(r"^\[\s*\"([^\"]*)\"\s*\]")
_SLICE_RE = re.compile(r"^\[\s*(-?\d+)?\s*:\s*(-?\d+)?\s*\]")
_INDEX_RE = re.compile(r"^\[\s*(-?\d+)\s*\]")
_ITERATE_RE = re.compile(r"^\[\s*\]")

_SUPPORTED = "Supported: .a.b, [0], [1:3], [], length, keys, and |."


def parse_filter(expression: str) -> List[List[Tuple[str, Any]]]:
    return [_parse_step(part.strip(), expression) for part in expression.split("|")]


def _parse_step(step: str, whole: str) -> List[Tuple[str, Any]]:
    if step in ("", "."):
        return []
    if step == "length":
        return [("length", None)]
    if step == "keys":
        return [("keys", None)]

    ops: List[Tuple[str, Any]] = []
    rest = step
    while rest:
        # `.[0]` and `[0]` mean the same thing, as in jq.
        if rest.startswith(".["):
            rest = rest[1:]
        key = _KEY_RE.match(rest)
        if key:
            ops.append(("key", key.group(1)))
            rest = rest[key.end():]
            continue
        quoted = _QUOTED_RE.match(rest)
        if quoted:
            ops.append(("key", quoted.group(1)))
            rest = rest[quoted.end():]
            continue
        sliced = _SLICE_RE.match(rest)
        if sliced and (sliced.group(1) is not None or sliced.group(2) is not None):
            start = int(sliced.group(1)) if sliced.group(1) is not None else None
            stop = int(sliced.group(2)) if sliced.group(2) is not None else None
            ops.append(("slice", (start, stop)))
            rest = rest[sliced.end():]
            continue
        index = _INDEX_RE.match(rest)
        if index:
            ops.append(("index", int(index.group(1))))
            rest = rest[index.end():]
            continue
        iterate = _ITERATE_RE.match(rest)
        if iterate:
            ops.append(("iterate", None))
            rest = rest[iterate.end():]
            continue
        raise RecipeError('unsupported filter near "{0}" in "{1}". {2}'.format(rest, whole, _SUPPORTED))
    return ops


def _apply_op(values: Sequence[Any], op: Tuple[str, Any]) -> List[Any]:
    kind, arg = op
    out: List[Any] = []
    for value in values:
        if kind == "key":
            if value is None:
                continue
            if not isinstance(value, dict):
                raise RecipeError("cannot read .{0} of {1}".format(arg, type(value).__name__))
            out.append(value.get(arg))
            continue
        if kind == "length":
            if isinstance(value, (list, tuple, str, dict)):
                out.append(len(value))
            elif value is None:
                out.append(0)
            else:
                raise RecipeError("length of {0} is not defined".format(type(value).__name__))
            continue
        if kind == "keys":
            if isinstance(value, (list, tuple)):
                out.append(list(range(len(value))))
            elif isinstance(value, dict):
                out.append(sorted(value.keys()))
            else:
                raise RecipeError("keys needs an object or an array")
            continue
        if not isinstance(value, (list, tuple)):
            raise RecipeError("cannot index {0} with []".format("null" if value is None else type(value).__name__))
        if kind == "iterate":
            out.extend(value)
        elif kind == "index":
            try:
                out.append(value[arg])
            except IndexError:
                out.append(None)
        else:
            start, stop = arg
            out.append(list(value[slice(start, stop)]))
    return out


def apply_filter(value: Any, expression: str) -> Any:
    """One value stays one value; a stream of several comes back as a list."""
    values: List[Any] = [value]
    for step in parse_filter(expression):
        for op in step:
            values = _apply_op(values, op)
    return values[0] if len(values) == 1 else values
