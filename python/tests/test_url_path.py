"""A profile name has to survive the trip into a URL path.

The server refuses a path segment that partially decodes and still holds a
``%xx`` - it reads as double encoding. ``quote(name, safe="")`` walks straight
into it: a name with a space *and* an ``@`` becomes ``%20…%40``, the server's
``decodeURI`` turns the space back but leaves ``%40``, and the request is
rejected before any route matches. For a profile that means cloud sync silently
stops working.
"""
from __future__ import annotations

import re
import urllib.parse

from antibrow.config import encode_path_segment

_HAS_ESCAPE = re.compile(r"%[0-9a-fA-F]{2}")


def trips_the_guard(segment: str) -> bool:
    """Mirror of the server-side check, so the invariant is asserted directly."""
    # decodeURI decodes everything except the reserved set.
    decoded = re.sub(
        r"%[0-9a-fA-F]{2}",
        lambda m: m.group(0) if m.group(0).upper() in _RESERVED else urllib.parse.unquote(m.group(0)),
        segment,
    )
    return decoded != segment and bool(_HAS_ESCAPE.search(decoded))


_RESERVED = {"%23", "%24", "%26", "%2B", "%2C", "%2F", "%3A", "%3B", "%3D", "%3F", "%40"}


def test_a_name_with_a_space_and_an_at_stays_single_level():
    name = "work mail@example.com"
    assert trips_the_guard(urllib.parse.quote(name, safe=""))   # the old spelling
    assert not trips_the_guard(encode_path_segment(name))
    assert encode_path_segment(name) == "work%20mail@example.com"


def test_leaves_every_character_a_path_segment_may_carry_raw():
    raw = "abc-._~!$&'()*+,;=:@"
    assert encode_path_segment(raw) == raw


def test_still_escapes_what_a_segment_cannot_carry():
    assert encode_path_segment("a/b") == "a%2Fb"
    assert encode_path_segment("a?b") == "a%3Fb"
    assert encode_path_segment("a#b") == "a%23b"
    assert encode_path_segment("a b") == "a%20b"
    assert encode_path_segment("a%b") == "a%25b"


def test_round_trips_through_the_decoding_the_server_does():
    for name in [
        "work mail@example.com",
        "gmail-agauche11",
        "café résumé",
        "o'brien+tag",
        "a:b;c=d,e",
        "plain",
    ]:
        assert urllib.parse.unquote(encode_path_segment(name)) == name
        assert not trips_the_guard(encode_path_segment(name))


def test_matches_the_node_sdk_spelling():
    # Both SDKs address the same profiles on the same server; a difference here
    # means one of them can reach a name the other cannot.
    assert encode_path_segment("café") == "caf%C3%A9"
    assert encode_path_segment("a b@c") == "a%20b@c"
