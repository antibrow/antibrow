from __future__ import annotations

import pytest

from antibrow.recipe import apply_filter
from antibrow.recipe.source import RecipeError

PAYLOAD = {
    "items": [
        {"id": "a", "title": "first", "score": 3},
        {"id": "b", "title": "second", "score": 9},
        {"id": "c", "title": "third", "score": 1},
    ],
    "meta": {"count": 3},
}


def test_identity():
    assert apply_filter(PAYLOAD, ".") is PAYLOAD
    assert apply_filter(PAYLOAD, "") is PAYLOAD


def test_path_and_iteration():
    assert apply_filter(PAYLOAD, ".meta.count") == 3
    assert apply_filter(PAYLOAD, ".items[].title") == ["first", "second", "third"]


def test_index_slice_length_keys():
    assert apply_filter(PAYLOAD, ".items[0].id") == "a"
    assert apply_filter(PAYLOAD, ".items[-1].id") == "c"
    assert apply_filter(PAYLOAD, ".items[0:2] | .[].id") == ["a", "b"]
    assert apply_filter(PAYLOAD, ".items | length") == 3
    assert apply_filter(PAYLOAD, ".meta | keys") == ["count"]


def test_quoted_key():
    assert apply_filter({"odd key": 7}, '.["odd key"]') == 7


def test_single_element_stream_stays_a_value():
    assert apply_filter({"items": [{"id": "only"}]}, ".items[].id") == "only"


# A filter that quietly returns null reads exactly like a site that returned
# nothing, so anything outside the subset has to say so.
def test_rejects_unsupported_expressions():
    with pytest.raises(RecipeError, match="unsupported filter"):
        apply_filter(PAYLOAD, ".items | map(.title)")
    with pytest.raises(RecipeError, match="unsupported filter"):
        apply_filter(PAYLOAD, ".items[] | select(.score > 2)")


def test_rejects_indexing_a_non_array():
    with pytest.raises(RecipeError, match="cannot index"):
        apply_filter(PAYLOAD, ".meta[]")


def test_missing_key_is_not_an_error():
    assert apply_filter(PAYLOAD, ".nope") is None


def test_matches_the_node_sdk_on_the_same_input():
    # Both SDKs ship the same subset; these are the cases the Node test asserts.
    assert apply_filter(PAYLOAD, ".items[].score") == [3, 9, 1]
    assert apply_filter(PAYLOAD, ".items[1:3] | length") == 2
