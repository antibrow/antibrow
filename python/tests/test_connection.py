"""navigator.connection must be a self-consistent trio, not a global constant."""

from __future__ import annotations

import pytest

from antibrow.persona import (
    ECT_RTT_THRESHOLDS,
    derive_connection,
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
    persona = generate_persona(150, "150.0.0.0")
    cfg = persona_to_fp_config(persona, label="p", timezone="UTC")
    assert cfg["connection"] != {"effectiveType": "4g", "rtt": 100, "downlink": 10}
    assert cfg["connection"] == derive_connection(persona.seed)


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
