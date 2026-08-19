"""navigator.connection must be a self-consistent trio, not a global constant."""

from __future__ import annotations

import pytest

from antibrow.persona import (
    ECT_RTT_THRESHOLDS,
    CapturedFacts,
    derive_connection,
    device_to_persona_parts,
    generate_persona,
    persona_to_fp_config,
)


def test_measured_rtt_snaps_to_the_25ms_grid():
    # 213 matches the JS suite's own golden assertion (connection.test.ts): 225,
    # not 200 - 213/25=8.52 rounds up under any standard rounding, half-up or not.
    assert derive_connection("abc", 187)["rtt"] == 175
    assert derive_connection("abc", 200)["rtt"] == 200
    assert derive_connection("abc", 213)["rtt"] == 225


def test_measured_rtt_is_clamped():
    assert derive_connection("abc", 1)["rtt"] == 25
    assert derive_connection("abc", 99999)["rtt"] == 3000


@pytest.mark.parametrize(
    "rtt,expected",
    [
        (ECT_RTT_THRESHOLDS["four_g"] - 25, "4g"),
        (ECT_RTT_THRESHOLDS["four_g"] + 25, "3g"),
        (ECT_RTT_THRESHOLDS["three_g"] + 25, "2g"),
        (ECT_RTT_THRESHOLDS["two_g"] + 25, "slow-2g"),
    ],
)
def test_effective_type_follows_rtt(rtt, expected):
    assert derive_connection("abc", rtt)["effectiveType"] == expected


@pytest.mark.parametrize("seed", ["0011223344556677", "ffeeddccbbaa9988", "a1b2c3d4e5f60718"])
def test_downlink_stays_on_the_grid_and_inside_its_type_range(seed):
    # 0.025 grid (25 kbps), Chrome's own step.
    fast = derive_connection(seed, 100)
    assert fast["effectiveType"] == "4g"
    assert 1 <= fast["downlink"] <= 10
    assert round(fast["downlink"] * 1000) % 25 == 0

    slow = derive_connection(seed, 600)
    assert slow["effectiveType"] == "3g"
    assert 0.4 <= slow["downlink"] <= 1.5
    assert round(slow["downlink"] * 1000) % 25 == 0


@pytest.mark.parametrize("rtt", [None, 0, -1, float("nan"), float("inf"), float("-inf")])
def test_unmeasured_falls_back_to_a_seed_derived_4g_trio(rtt):
    # nan/inf/-inf must fall through to the seed-derived branch exactly as JS's
    # Number.isFinite guard does - +inf is where the two suites diverged before.
    c = derive_connection("0011223344556677", rtt)
    assert c["effectiveType"] == "4g"
    assert c["rtt"] < ECT_RTT_THRESHOLDS["four_g"]
    assert c["rtt"] % 25 == 0


def test_stable_per_seed_and_varies_across_seeds():
    assert derive_connection("0011223344556677") == derive_connection("0011223344556677")
    seeds = ["0011223344556677", "ffeeddccbbaa9988", "a1b2c3d4e5f60718", "1234567890abcdef"]
    assert len({derive_connection(s)["downlink"] for s in seeds}) > 1


def test_fp_config_no_longer_emits_the_old_constant():
    # Fixed seeds, not generated ones: rtt lands on a 25ms grid that includes
    # 100 and downlink tops out at exactly 10, so a random persona hits the old
    # constant roughly once in three thousand runs and turns this into a flake.
    for seed in ("0011223344556677", "ffeeddccbbaa9988", "a1b2c3d4e5f60718"):
        persona = generate_persona(150, "150.0.0.0")
        persona.seed = seed
        cfg = persona_to_fp_config(persona, label="p", timezone="UTC")
        assert cfg["connection"] != {"effectiveType": "4g", "rtt": 100, "downlink": 10}
        assert cfg["connection"] == derive_connection(seed)


def test_fp_config_uses_the_measured_rtt():
    persona = generate_persona(150, "150.0.0.0")
    cfg = persona_to_fp_config(persona, label="p", timezone="UTC", rtt_ms=640)
    assert cfg["connection"] == derive_connection(persona.seed, 640)
    assert cfg["connection"]["effectiveType"] == "3g"


# Cross-SDK contract: these must match the JS suite's golden values verbatim
# (oss/js/tests/engine/connection.test.ts, "matches known golden values for
# fixed seeds"). Never recompute them from the formula below - if they drift,
# the two SDKs disagree about a persona's fingerprint.
@pytest.mark.parametrize(
    "seed,unmeasured,measured_600",
    [
        (
            "0011223344556677",
            {"effectiveType": "4g", "rtt": 175, "downlink": 3.55},
            {"effectiveType": "3g", "rtt": 600, "downlink": 0.75},
        ),
        (
            "ffeeddccbbaa9988",
            {"effectiveType": "4g", "rtt": 225, "downlink": 9.425},
            {"effectiveType": "3g", "rtt": 600, "downlink": 1.025},
        ),
        (
            "a1b2c3d4e5f60718",
            {"effectiveType": "4g", "rtt": 225, "downlink": 1.775},
            {"effectiveType": "3g", "rtt": 600, "downlink": 1.25},
        ),
        (
            "1234567890abcdef",
            {"effectiveType": "4g", "rtt": 200, "downlink": 1.975},
            {"effectiveType": "3g", "rtt": 600, "downlink": 1.45},
        ),
    ],
)
def test_matches_known_golden_values_for_fixed_seeds(seed, unmeasured, measured_600):
    assert derive_connection(seed) == unmeasured
    assert derive_connection(seed, 600) == measured_600


# A fractional rtt_ms is not a hypothetical: geoip.py's monotonic-clock probe
# is the only kind of rtt the Python SDK ever produces in production, and
# 462.5/25 = 18.5 is exactly the half-way case where JS's half-up Math.round
# and Python's banker's-rounding round() could part company - floor(x + 0.5)
# is why they don't. Cross-SDK contract with connection.test.ts's "matches
# known golden values for a fractional rttMs".
@pytest.mark.parametrize(
    "seed,expected",
    [
        ("0011223344556677", {"effectiveType": "3g", "rtt": 475, "downlink": 0.75}),
        ("ffeeddccbbaa9988", {"effectiveType": "3g", "rtt": 475, "downlink": 1.025}),
        ("a1b2c3d4e5f60718", {"effectiveType": "3g", "rtt": 475, "downlink": 1.25}),
        ("1234567890abcdef", {"effectiveType": "3g", "rtt": 475, "downlink": 1.45}),
    ],
)
@pytest.mark.parametrize("rtt_ms", [462.5, 462.7])
def test_matches_known_golden_values_for_a_fractional_rtt(seed, expected, rtt_ms):
    assert derive_connection(seed, rtt_ms) == expected


# One real Windows box out of the device library. rtt 250 / 4g / 4.5 is a trio
# Chrome itself emitted, so it hangs together; the point of these tests is that
# nothing ever ships two thirds of it beside a third from somewhere else.
# Cross-SDK contract with connection.test.ts's "a replayed device's connection".
CORPUS_DEVICE = {
    "os": "windows",
    "ua": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
    ),
    "navigator": {"hardwareConcurrency": 16, "deviceMemory": 32},
    "screen": {"width": 1920, "height": 1080, "devicePixelRatio": 1},
    "connection": {"effectiveType": "4g", "rtt": 250, "downlink": 4.5, "type": "wifi"},
    "webgl": {"unmaskedVendor": "Google Inc. (Intel)", "unmaskedRenderer": "ANGLE (Intel, …)"},
}


@pytest.fixture()
def corpus_captured():
    return device_to_persona_parts(CORPUS_DEVICE, 151)["captured"]


def test_replayed_device_carries_the_whole_trio(corpus_captured):
    assert corpus_captured.connection_effective_type == "4g"
    assert corpus_captured.connection_rtt == 250
    assert corpus_captured.connection_downlink == 4.5


def test_replays_the_captured_trio_verbatim_when_nothing_measured(corpus_captured):
    assert derive_connection("0011223344556677", None, corpus_captured) == {
        "effectiveType": "4g",
        "rtt": 250,
        "downlink": 4.5,
    }


def test_captured_trio_is_discarded_whole_once_rtt_is_measured(corpus_captured):
    # The bug: effectiveType came from the corpus machine while rtt came from the
    # proxy probe, shipping '4g' beside rtt 400 - a contradiction Chrome's own
    # thresholds rule out, and one a site can catch by timing us itself.
    got = derive_connection("0011223344556677", 400, corpus_captured)
    assert got == derive_connection("0011223344556677", 400)
    assert got["effectiveType"] == "3g"


def test_never_mixes_when_only_part_of_the_trio_was_captured():
    # What every persona.json written before the trio travelled together looks
    # like. Half a reading is worse than none: derive all three instead.
    partial = CapturedFacts(connection_effective_type="4g")
    assert derive_connection("0011223344556677", None, partial) == derive_connection(
        "0011223344556677"
    )


def test_effective_type_still_agrees_with_rtt_through_fp_config():
    persona = generate_persona(151, "151", device=CORPUS_DEVICE)
    cfg = persona_to_fp_config(persona, label="p", timezone="UTC", rtt_ms=400)
    connection = cfg["connection"]
    assert connection["rtt"] == 400
    assert connection["effectiveType"] == "3g"
    assert connection["downlink"] <= 1.5
    # The medium is not latency-derived, so it still comes from the corpus row.
    assert connection["type"] == "wifi"
