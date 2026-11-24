"""
Tests for Phase 1 session-level aggregation in ``backend.ml.degradation``.

The aggregation tests here guard against selection on the outcome. A compound median or an
anomaly peer group must pool every stint whose tyre-life span is long enough
(``comparable``), not only those whose degradation is significantly different from zero
(``significant``). A flat stint is exactly the one that fails a test against zero, so
filtering on significance before aggregating keeps the steep stints and discards the flat
ones. The shipped Phase 1 code did that, and overstated every compound median by about half
on real data.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from backend.ml.degradation import DegradationOptions, analyse_session_degradation
from backend.tests.fixtures.synthetic import make_stint

#: Corrections disabled throughout: in these fixtures lap_number equals tyre_life, so a fuel
#: correction would add the same constant slope to every stint and obscure what is tested.
NO_CORRECTIONS = DegradationOptions(corrections=(), detail="summary")

FLAT_DEG, STEEP_DEG = 0.0, 0.10


def _session_with_flat_and_steep_stints(n_each: int = 4) -> pd.DataFrame:
    """
    One compound, every stint spanning the nominal window, half flat and noisy, half steep.

    Flat stints are noisy enough to be insignificant; steep ones are clean enough to be
    significant. Everything is MEDIUM and spans tyre life 1-20, so every stint is
    ``comparable`` and shares one peer group, and the only difference between them is the
    one under test.
    """
    frames = []
    for i in range(n_each):
        frames.append(make_stint(
            n_laps=20, deg=FLAT_DEG, noise=0.6, driver=f"F{i:02d}", seed=100 + i,
        ))
        frames.append(make_stint(
            n_laps=20, deg=STEEP_DEG, noise=0.05, driver=f"S{i:02d}", seed=200 + i,
        ))
    laps = pd.concat(frames, ignore_index=True)
    laps["year"] = 2024
    laps["circuit_name"] = "Testville"
    laps["event_name"] = "Test Grand Prix"
    laps["session_type"] = "R"
    laps["session_median_lap_time"] = laps["lap_time"].median()
    return laps


def test_fixture_actually_contains_insignificant_stints():
    """Guard: without insignificant flat stints the tests below would prove nothing."""
    payload = analyse_session_degradation(_session_with_flat_and_steep_stints(), NO_CORRECTIONS)
    flat = [s for s in payload["stints"] if s["driver"].startswith("F")]
    steep = [s for s in payload["stints"] if s["driver"].startswith("S")]

    assert flat and all(not s["degradation"]["significant"] for s in flat)
    assert steep and all(s["degradation"]["significant"] for s in steep)
    assert all(s["degradation"]["comparable"] for s in payload["stints"])


def test_compound_summary_includes_flat_stints():
    """
    The regression test for the selection-on-outcome bug.

    With four flat and four steep stints the true median is roughly halfway between them. If
    insignificant stints are excluded, only the steep ones remain and the median jumps to the
    steep rate. That is what the shipped code did.
    """
    payload = analyse_session_degradation(_session_with_flat_and_steep_stints(), NO_CORRECTIONS)
    (medium,) = [c for c in payload["compound_summary"] if c["compound"] == "MEDIUM"]

    assert medium["n_stints"] == 8
    assert medium["n_stints_comparable"] == 8, "flat, insignificant stints must be pooled"

    median = medium["median_deg_s_per_lap"]
    assert median < 0.8 * STEEP_DEG, (
        f"median {median:+.4f} sits at the steep-only rate: flat stints were excluded"
    )
    assert median > FLAT_DEG


def test_anomaly_peer_groups_include_flat_stints():
    """Peers must include insignificant stints, or the z-score distribution is truncated."""
    payload = analyse_session_degradation(_session_with_flat_and_steep_stints(), NO_CORRECTIONS)

    for stint in payload["stints"]:
        assert stint["anomaly"] is not None
        assert stint["anomaly"]["peer_count"] == 8
        assert stint["anomaly"]["peer_group"] == "MEDIUM:nominal"


def test_steep_stints_score_positive_against_a_mixed_field():
    """With flat stints present as peers, the steep stints sit above the peer mean."""
    payload = analyse_session_degradation(_session_with_flat_and_steep_stints(), NO_CORRECTIONS)
    steep_z = [s["anomaly"]["z_score"] for s in payload["stints"] if s["driver"].startswith("S")]
    flat_z = [s["anomaly"]["z_score"] for s in payload["stints"] if s["driver"].startswith("F")]

    assert np.mean(steep_z) > 0 > np.mean(flat_z)
