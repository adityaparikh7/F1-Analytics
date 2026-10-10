"""
Contract tests for the clean-lap SQL predicate.

Asserted against the hand-written seed set in ``fixtures/seed_laps.py``, where every
disqualifying property is isolated to its own driver code, so a failure names the clause
that broke.

The most important assertion in this file is that ``track_status = '14'`` is excluded. That
is the substring trap: TrackStatus concatenates codes, so '14' and '124' both *contain* '1'
while describing laps that were not all-clear, and a ``LIKE '%1%'`` would silently admit
them.
"""

from __future__ import annotations

from backend.db import queries as q
from backend.ml.constants import CLEAN_COMPOUNDS, POOLED_MIN_YEAR


def _drivers(frame) -> set[str]:
    return set(frame["driver"].unique())


# ── What survives ──────────────────────────────────────────────────────

def test_only_the_clean_driver_survives_filtering(duckdb_conn):
    """
    Of all the seeded drivers, only CLN has laps that are clean *and* in a long enough
    stint. Every other driver carries exactly one disqualifying property.
    """
    laps = q.get_clean_stint_laps("2024_01_R")
    assert _drivers(laps) == {"CLN"}
    assert len(laps) == 20  # two stints of ten
    assert set(laps["stint"].unique()) == {1, 2}


def test_clean_laps_carry_the_derived_columns(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R")
    for column in ("session_median_lap_time", "clean_lap_count", "circuit_name", "year"):
        assert column in laps.columns
    assert (laps["clean_lap_count"] == 10).all()
    assert laps["session_median_lap_time"].notna().all()


# ── Compound whitelist ─────────────────────────────────────────────────

def test_junk_compound_values_are_rejected(duckdb_conn):
    """
    'nan', NULL and 'UNKNOWN' must all be excluded.

    The literal string 'nan' is real: ``ingest.py`` applies ``.astype(str)`` to the FastF1
    compound column, which stringifies NaN. An inclusive whitelist rejects it and anything
    else unexpected; a blacklist would have to enumerate them.
    """
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"NAN", "NUL", "UNK"} & _drivers(laps)
    assert not laps["compound"].isin(["nan", "UNKNOWN"]).any()
    assert laps["compound"].notna().all()


def test_wet_compounds_are_excluded_from_dry_degradation(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert "INT" not in _drivers(laps)
    assert not laps["compound"].isin(["INTERMEDIATE", "WET"]).any()


def test_legacy_compounds_are_allowed_in_phase_one(duckdb_conn):
    """
    A per-stint descriptive fit makes no cross-compound claim, so 2018's SUPERSOFT /
    ULTRASOFT / HYPERSOFT are usable there — unlike in pooled training.
    """
    laps = q.get_clean_stint_laps("2018_01_R")
    assert _drivers(laps) == {"LEG"}
    assert set(laps["compound"].unique()) == {"ULTRASOFT"}


def test_single_compound_filter_narrows_results(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", compound="hard")
    assert set(laps["compound"].unique()) == {"HARD"}
    assert len(laps) == 10


# ── Track status: the substring trap ───────────────────────────────────

def test_concatenated_track_status_codes_are_excluded(duckdb_conn):
    """
    '14' and '124' contain '1' but are not all-clear, and must be excluded.

    This is the single assertion most likely to catch a well-meaning "simplification" of the
    predicate into a LIKE or an ``.includes``-style test.
    """
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"T14", "T24"} & _drivers(laps)
    assert set(laps["driver"].unique()) <= {"CLN", "SHT"}


def test_safety_car_and_vsc_laps_are_excluded(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"TS4", "TS6"} & _drivers(laps)


# ── Pit laps and null measurements ─────────────────────────────────────

def test_pit_in_and_pit_out_laps_are_excluded(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"PIO", "PII"} & _drivers(laps)


def test_null_measurements_are_excluded(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"NLT", "NTL", "NST"} & _drivers(laps)


def test_lap_times_outside_the_sanity_bounds_are_excluded(duckdb_conn):
    laps = q.get_clean_stint_laps("2024_01_R", min_clean_laps=1)
    assert not {"LOW", "HIG"} & _drivers(laps)


# ── Stint length threshold ─────────────────────────────────────────────

def test_short_stints_are_dropped_at_the_default_threshold(duckdb_conn):
    """SHT has three clean laps — valid, but not enough to fit."""
    assert "SHT" not in _drivers(q.get_clean_stint_laps("2024_01_R"))
    assert "SHT" in _drivers(q.get_clean_stint_laps("2024_01_R", min_clean_laps=3))


def test_raising_the_threshold_drops_more_stints(duckdb_conn):
    assert q.get_clean_stint_laps("2024_01_R", min_clean_laps=11).empty


# ── Driver resolution: abbreviation or number ──────────────────────────

def test_driver_accepts_abbreviation_or_number(duckdb_conn):
    by_abbrev = q.get_clean_stint_laps("2024_01_R", driver="CLN")
    by_number = q.get_clean_stint_laps("2024_01_R", driver="11")
    assert len(by_abbrev) == len(by_number) == 20
    assert _drivers(by_abbrev) == _drivers(by_number) == {"CLN"}


def test_driver_abbreviation_is_case_insensitive(duckdb_conn):
    assert len(q.get_clean_stint_laps("2024_01_R", driver="cln")) == 20


# ── Pooled training loader ─────────────────────────────────────────────

def test_training_loader_excludes_legacy_years_and_compounds(duckdb_conn):
    """
    2018 is excluded by ``min_year``, and its compounds would be excluded anyway by the
    modern-three whitelist — which is exactly why including the year would be misleading.
    """
    laps = q.get_clean_training_laps(min_year=POOLED_MIN_YEAR)
    assert 2018 not in set(laps["year"].unique())
    assert set(laps["compound"].unique()) <= set(CLEAN_COMPOUNDS)


def test_training_loader_includes_only_races(duckdb_conn):
    laps = q.get_clean_training_laps(min_year=2024)
    assert set(laps["session_type"].unique()) == {"R"}
    assert "2024_01_Q" not in set(laps["session_key"].unique())


def test_training_loader_spans_multiple_sessions_with_per_session_medians(duckdb_conn):
    """
    The median must be computed per session over clean laps only — the two seeded races have
    deliberately different lap-time scales, so a single global median would be visible.
    """
    laps = q.get_clean_training_laps(min_year=2024)
    assert set(laps["session_key"].unique()) == {"2024_01_R", "2024_02_R"}

    medians = laps.groupby("session_key")["session_median_lap_time"].nunique()
    assert (medians == 1).all(), "each session must have exactly one median"

    distinct = laps.groupby("session_key")["session_median_lap_time"].first()
    assert distinct["2024_01_R"] != distinct["2024_02_R"]


def test_training_loader_respects_the_year_range(duckdb_conn):
    assert q.get_clean_training_laps(min_year=2019, max_year=2023).empty
    assert not q.get_clean_training_laps(min_year=2024, max_year=2024).empty
