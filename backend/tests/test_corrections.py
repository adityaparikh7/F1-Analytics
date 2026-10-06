"""
Tests for lap-time corrections.

:func:`test_fuel_correction_is_monotone_across_a_pit_stop` is the highest-value test in the
suite: it pins both halves of the bug at
``analytics/tyres/tyre-performance-modeling.py:318`` — the stint-relative lap counter and
the inverted sign — and a stint-relative or sign-flipped implementation cannot pass it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backend.ml.constants import FUEL_S_PER_LAP
from backend.ml.corrections import (
    apply_corrections,
    describe_corrections,
    fuel_correction,
    track_temp_correction,
)
from backend.tests.fixtures.synthetic import make_stint, make_two_stint_race

# ── Fuel (F6a, F6b) ────────────────────────────────────────────────────

def test_fuel_correction_is_monotone_across_a_pit_stop():
    """
    The fuel adjustment must keep rising across a pit stop.

    Fuel burns monotonically over a race and is not replenished at a stop. The local script
    keys its correction on StintLap, which resets to 1 at every stop; that implementation
    produces a saw-tooth and would fail here. ``tyre_life`` resets in this fixture while
    ``lap_number`` keeps counting, so the two implementations are distinguishable.
    """
    race = make_two_stint_race(n_laps=10)
    assert race.tyre_life.iloc[10] < race.tyre_life.iloc[9], "fixture must reset tyre_life"
    assert race.lap_number.iloc[10] > race.lap_number.iloc[9], "fixture must continue lap_number"

    result = fuel_correction(race)
    assert result.applied

    diffs = np.diff(result.adjustment)
    assert np.all(diffs > 0), (
        "fuel adjustment must increase on every lap including across the stop; a "
        "stint-relative implementation saw-tooths back down at the pit stop"
    )


def test_fuel_correction_adds_time_so_later_laps_are_adjusted_upward():
    """
    The sign: burning fuel makes laps faster, so removing the effect ADDS time back, and
    adds more of it the later the lap. Subtracting — as the prior art does — doubles the
    effect instead of cancelling it.
    """
    stint = make_stint(n_laps=10, lap_number_start=1)
    result = fuel_correction(stint, coef=0.055)

    assert result.adjustment[0] < result.adjustment[-1]
    assert result.adjustment[-1] > 0
    assert result.adjustment[-1] == pytest.approx(0.055 * stint.lap_number.iloc[-1])


def test_fuel_correction_removes_a_known_fuel_trend():
    """
    End to end: a stint with flat true pace but a fuel-driven downward drift should come out
    flat once corrected.
    """
    n = 20
    coef = 0.055
    lap_number = np.arange(1, n + 1, dtype=float)
    laps = pd.DataFrame({
        "lap_number": lap_number,
        # True pace constant at 90.0; observed times fall purely because of fuel burn-off.
        "lap_time": 90.0 - coef * lap_number,
        "tyre_life": lap_number,
    })

    corrected, _ = apply_corrections(laps, names=("fuel",))
    assert np.std(corrected) == pytest.approx(0.0, abs=1e-9)


def test_fuel_correction_keys_on_lap_number_not_tyre_life():
    """Explicitly: the adjustment must be a function of lap_number alone."""
    laps = pd.DataFrame({
        "lap_number": [1, 2, 3, 4],
        "tyre_life": [9, 1, 2, 3],   # deliberately unrelated to lap_number
        "lap_time": [90.0, 90.0, 90.0, 90.0],
    })
    result = fuel_correction(laps, coef=0.1)
    np.testing.assert_allclose(result.adjustment, [0.1, 0.2, 0.3, 0.4])


def test_fuel_correction_skips_when_lap_number_missing():
    laps = pd.DataFrame({"lap_time": [90.0, 90.1], "tyre_life": [1, 2]})
    result = fuel_correction(laps)
    assert not result.applied
    assert "lap_number" in result.reason


# ── Track temperature: registered but inert ────────────────────────────

def test_track_temp_correction_reports_itself_skipped_without_weather_data():
    """
    The hook must be visible, not silent.

    No weather is ingested, so this correction cannot run — but it has to say why, so the
    API can surface it and the UI can state that degradation is uncorrected for track
    temperature rather than implying it was accounted for.
    """
    stint = make_stint(n_laps=10)
    result = track_temp_correction(stint)

    assert not result.applied
    assert "track_temp" in result.reason
    assert "weather=False" in result.reason
    np.testing.assert_allclose(result.adjustment, np.zeros(len(stint)))


def test_track_temp_correction_applies_when_data_and_coefficient_exist():
    """
    Proves the drop-in path works before the data exists: supply a track_temp column and a
    coefficient, and the correction engages with no other change.
    """
    stint = make_stint(n_laps=10)
    stint["track_temp"] = np.linspace(30.0, 40.0, len(stint))

    result = track_temp_correction(stint, coef=0.01)
    assert result.applied
    assert result.params["mean_track_temp"] == pytest.approx(35.0)
    # Hotter than the session mean => penalty removed => negative adjustment.
    assert result.adjustment[-1] < 0 < result.adjustment[0]


def test_track_temp_correction_skips_on_zero_coefficient():
    stint = make_stint(n_laps=10)
    stint["track_temp"] = 35.0
    result = track_temp_correction(stint, coef=0.0)
    assert not result.applied
    assert "zero" in result.reason


# ── Registry behaviour ─────────────────────────────────────────────────

def test_apply_corrections_with_empty_names_returns_raw_lap_times():
    stint = make_stint(n_laps=10)
    corrected, results = apply_corrections(stint, names=())
    np.testing.assert_allclose(corrected, stint.lap_time.values)
    assert results == []


def test_apply_corrections_reports_unknown_name_instead_of_raising():
    stint = make_stint(n_laps=10)
    corrected, results = apply_corrections(stint, names=("fuel", "nonsense"))

    names = {r.name: r for r in results}
    assert names["fuel"].applied
    assert not names["nonsense"].applied
    assert "unknown correction" in names["nonsense"].reason
    # The valid correction still took effect.
    assert not np.allclose(corrected, stint.lap_time.values)


def test_describe_corrections_splits_applied_and_skipped_for_the_api():
    stint = make_stint(n_laps=10)
    _, results = apply_corrections(stint, names=("fuel", "track_temp"))
    applied, skipped = describe_corrections(results)

    assert [a["name"] for a in applied] == ["fuel"]
    assert applied[0]["coef_s_per_lap"] == FUEL_S_PER_LAP
    assert applied[0]["keyed_on"] == "lap_number"
    assert [s["name"] for s in skipped] == ["track_temp"]
    assert skipped[0]["reason"]
