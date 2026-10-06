"""
F1 Pitwall — DuckDB Query Functions

Reusable query helpers that return data as lists of dicts (JSON-ready).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

import numpy as np
import pandas as pd

from backend.db.connection import get_connection
from backend.ml.constants import (
    ALL_DRY_COMPOUNDS,
    CLEAN_COMPOUNDS,
    LAP_TIME_MAX_S,
    LAP_TIME_MIN_S,
    MIN_CLEAN_LAPS,
    POOLED_MIN_CLEAN_LAPS,
    POOLED_SESSION_TYPES,
    TRACK_STATUS_ALL_CLEAR,
)

logger = logging.getLogger(__name__)


def _fetchall_dicts(sql: str, params: list | None = None) -> list[dict]:
    """Execute a query and return results as a list of dicts."""
    conn = get_connection()
    result = conn.execute(sql, params or []).fetchdf()
    return result.replace({np.nan: None}).to_dict(orient="records")


def _fetchdf(sql: str, params: list | None = None) -> pd.DataFrame:
    """
    Execute a query and return the raw DataFrame.

    Sibling of :func:`_fetchall_dicts` for analytical callers. The pooled tyre model pulls
    ~150k rows, and routing those through ``.replace({np.nan: None}).to_dict("records")``
    would be needlessly slow and memory-hungry when the consumer wants a frame anyway.
    """
    conn = get_connection()
    return conn.execute(sql, params or []).fetchdf()


def _driver_predicate(driver: str | None) -> tuple[str, list]:
    """
    Build the SQL fragment matching a driver given either form of identifier.

    Every driver parameter across the API accepts a three-letter abbreviation (``VER``) or
    a car number (``1``). Returns ``(sql_fragment, params)``; both are empty when *driver*
    is None, so callers can concatenate unconditionally.
    """
    if not driver:
        return "", []
    if driver.isdigit():
        return " AND driver_number = ?", [int(driver)]
    return " AND driver = ?", [driver.upper()]


# ── Clean laps (tyre degradation modelling) ────────────────────────────

#: Rows that are usable for fitting a tyre degradation curve.
#:
#: Shared verbatim by Phase 1 (one session, descriptive curves) and Phase 2 (all races,
#: pooled model) so that the two agree *exactly*. If they diverged, Phase 2 residuals
#: would be computed against a different lap population than the Phase 1 curves they are
#: displayed beside, and the drift would be close to undebuggable from the panel.
#:
#: Expects the ``laps`` table aliased as ``l``. Three of these clauses are traps; see
#: ``backend.ml.constants`` for the full reasoning behind each:
#:
#: 1. ``track_status = '1'`` is EXACT equality, not a LIKE. TrackStatus concatenates codes,
#:    so '14' and '124' contain '1' without being all-clear.
#: 2. The compound test is an inclusive WHITELIST. The table holds the literal string
#:    'nan', SQL NULL and 'UNKNOWN'; a whitelist rejects those and any future junk value
#:    for free. Do not rewrite it as NOT IN.
#: 3. The lap-time bounds are a loose garbage guard only — deliberately NOT a 107% filter,
#:    which would delete the slow late-stint laps that carry the degradation signal.
CLEAN_LAP_PREDICATE = f"""
    l.lap_time IS NOT NULL
    AND l.lap_time BETWEEN {LAP_TIME_MIN_S} AND {LAP_TIME_MAX_S}
    AND l.tyre_life IS NOT NULL
    AND l.stint IS NOT NULL
    AND l.track_status = '{TRACK_STATUS_ALL_CLEAR}'
    AND (l.is_pit_in_lap = FALSE OR l.is_pit_in_lap IS NULL)
    AND (l.is_pit_out_lap = FALSE OR l.is_pit_out_lap IS NULL)
    AND l.compound IS NOT NULL
"""


def _compound_filter(compounds: Sequence[str]) -> tuple[str, list]:
    """Build the whitelist fragment for *compounds*, upper-cased."""
    if not compounds:
        raise ValueError("compounds must be a non-empty whitelist")
    placeholders = ", ".join("?" for _ in compounds)
    return f" AND upper(l.compound) IN ({placeholders})", [c.upper() for c in compounds]


def get_clean_stint_laps(
    session_key: str,
    driver: str | None = None,
    compound: str | None = None,
    compounds: Sequence[str] = ALL_DRY_COMPOUNDS,
    min_clean_laps: int = MIN_CLEAN_LAPS,
) -> pd.DataFrame:
    """
    Clean laps for one session, restricted to stints long enough to fit.

    Returns one row per clean lap with the stint's ``clean_lap_count`` attached, plus
    ``session_median_lap_time`` — the median over this session's clean laps, which Phase 2
    uses to normalise away circuit lap length. Stints with fewer than *min_clean_laps*
    clean laps are dropped.

    *compound* filters to a single compound (the API's user-facing parameter); *compounds*
    is the whitelist of what counts as a dry compound at all. Legacy 2018 compounds are
    included by default because a per-stint descriptive fit makes no cross-compound claim.
    """
    selected = [compound] if compound else list(compounds)
    compound_sql, compound_params = _compound_filter(selected)
    driver_sql, driver_params = _driver_predicate(driver)

    sql = f"""
        WITH clean AS (
            SELECT
                l.session_key, l.driver, l.driver_number, l.team,
                l.lap_number, l.lap_time, l.compound, l.tyre_life, l.stint,
                s.year, s.circuit_name, s.event_name, s.session_type
            FROM laps l
            JOIN sessions s USING (session_key)
            WHERE l.session_key = ?
              AND {CLEAN_LAP_PREDICATE}
              {compound_sql}
              {driver_sql}
        ),
        session_median AS (
            SELECT median(lap_time) AS session_median_lap_time FROM clean
        )
        SELECT c.*, m.session_median_lap_time,
               COUNT(*) OVER (PARTITION BY c.driver, c.stint) AS clean_lap_count
        FROM clean c CROSS JOIN session_median m
        QUALIFY clean_lap_count >= ?
        ORDER BY c.driver, c.stint, c.tyre_life
    """
    params = [session_key, *compound_params, *driver_params, min_clean_laps]
    return _fetchdf(sql, params)


def get_clean_training_laps(
    min_year: int,
    max_year: int | None = None,
    session_types: Sequence[str] = POOLED_SESSION_TYPES,
    compounds: Sequence[str] = CLEAN_COMPOUNDS,
    min_clean_laps: int = POOLED_MIN_CLEAN_LAPS,
) -> pd.DataFrame:
    """
    Clean laps across many seasons, for pooled model training.

    Same predicate as :func:`get_clean_stint_laps`, scoped by year and session type, with
    the per-session clean median attached via an explicit CTE joined back on
    ``session_key``. The CTE form is used rather than a window function so it is
    unambiguous that the median covers only *clean* laps.

    Defaults to the modern three compounds and races only — see POOLED_MIN_YEAR and
    POOLED_SESSION_TYPES for why.
    """
    compound_sql, compound_params = _compound_filter(compounds)
    type_placeholders = ", ".join("?" for _ in session_types)

    sql = f"""
        WITH clean AS (
            SELECT
                l.session_key, l.driver, l.driver_number, l.team,
                l.lap_number, l.lap_time, l.compound, l.tyre_life, l.stint,
                s.year, s.round_number, s.circuit_name, s.event_name, s.session_type
            FROM laps l
            JOIN sessions s USING (session_key)
            WHERE s.year >= ?
              AND (? IS NULL OR s.year <= ?)
              AND s.session_type IN ({type_placeholders})
              AND {CLEAN_LAP_PREDICATE}
              {compound_sql}
        ),
        session_median AS (
            SELECT session_key, median(lap_time) AS session_median_lap_time
            FROM clean GROUP BY session_key
        )
        SELECT c.*, m.session_median_lap_time,
               COUNT(*) OVER (PARTITION BY c.session_key, c.driver, c.stint) AS clean_lap_count
        FROM clean c JOIN session_median m USING (session_key)
        QUALIFY clean_lap_count >= ?
        ORDER BY c.session_key, c.driver, c.stint, c.tyre_life
    """
    params = [min_year, max_year, max_year, *session_types, *compound_params, min_clean_laps]
    return _fetchdf(sql, params)


# ── Sessions ───────────────────────────────────────────────────────────

def list_sessions(year: int | None = None) -> list[dict]:
    sql = "SELECT * FROM sessions"
    params = []
    if year is not None:
        sql += " WHERE year = ?"
        params.append(year)
    sql += " ORDER BY year DESC, round_number DESC, date DESC"
    return _fetchall_dicts(sql, params)


def get_session(session_key: str) -> dict | None:
    rows = _fetchall_dicts("SELECT * FROM sessions WHERE session_key = ?", [session_key])
    return rows[0] if rows else None


def session_exists(session_key: str) -> bool:
    conn = get_connection()
    result = conn.execute("SELECT 1 FROM sessions WHERE session_key = ?", [session_key]).fetchone()
    return result is not None


# ── Laps ───────────────────────────────────────────────────────────────

def get_laps(
    session_key: str,
    driver: str | None = None,
    compound: str | None = None,
    exclude_pit_laps: bool = False,
) -> list[dict]:
    sql = "SELECT * FROM laps WHERE session_key = ?"
    params: list = [session_key]

    driver_sql, driver_params = _driver_predicate(driver)
    sql += driver_sql
    params.extend(driver_params)
    if compound:
        sql += " AND compound = ?"
        params.append(compound.upper())
    if exclude_pit_laps:
        sql += " AND (is_pit_in_lap = false OR is_pit_in_lap IS NULL)"
        sql += " AND (is_pit_out_lap = false OR is_pit_out_lap IS NULL)"

    sql += " ORDER BY driver, lap_number"
    return _fetchall_dicts(sql, params)


def get_stints(session_key: str, driver: str | None = None) -> list[dict]:
    """Aggregate stint information from lap data."""
    sql = """
        SELECT
            session_key,
            driver,
            team,
            stint,
            compound,
            MIN(lap_number) AS start_lap,
            MAX(lap_number) AS end_lap,
            COUNT(*) AS lap_count,
            AVG(CASE WHEN (is_pit_out_lap = false OR is_pit_out_lap IS NULL) AND (is_pit_in_lap = false OR is_pit_in_lap IS NULL) THEN lap_time ELSE NULL END) AS avg_lap_time,
            MIN(CASE WHEN (is_pit_out_lap = false OR is_pit_out_lap IS NULL) AND (is_pit_in_lap = false OR is_pit_in_lap IS NULL) THEN lap_time ELSE NULL END) AS best_lap_time
        FROM laps
        WHERE session_key = ? AND stint IS NOT NULL
    """
    params: list = [session_key]
    driver_sql, driver_params = _driver_predicate(driver)
    sql += driver_sql
    params.extend(driver_params)
    sql += " GROUP BY session_key, driver, team, stint, compound ORDER BY driver, stint"
    return _fetchall_dicts(sql, params)


# ── Results ────────────────────────────────────────────────────────────

def get_results(session_key: str) -> list[dict]:
    return _fetchall_dicts(
        "SELECT * FROM results WHERE session_key = ? ORDER BY position",
        [session_key],
    )


# ── Standings ──────────────────────────────────────────────────────────

def get_driver_standings(year: int, round_number: int | None = None) -> list[dict]:
    sql = """
        WITH max_round AS (
            SELECT COALESCE(?, MAX(round_number)) AS rnd
            FROM sessions
            WHERE year = ? AND session_key IN (SELECT session_key FROM results)
        ),
        driver_stats AS (
            SELECT
                s.year,
                r.driver,
                MAX(r.driver_number) AS driver_number,
                arg_max(r.team, s.round_number) AS team,
                SUM(COALESCE(r.points, 0)) AS points,
                SUM(CASE WHEN r.position = 1 AND s.session_type = 'R' THEN 1 ELSE 0 END) AS wins
            FROM results r
            JOIN sessions s ON r.session_key = s.session_key
            CROSS JOIN max_round m
            WHERE s.year = ? AND s.round_number <= m.rnd
            GROUP BY s.year, r.driver
            HAVING SUM(CASE WHEN s.session_type != 'FP1' THEN 1 ELSE 0 END) > 0
        )
        SELECT
            year,
            (SELECT rnd FROM max_round) AS round_number,
            CAST(ROW_NUMBER() OVER(ORDER BY points DESC, wins DESC) AS INTEGER) AS position,
            driver,
            driver_number,
            team,
            points,
            CAST(wins AS INTEGER) AS wins
        FROM driver_stats
        ORDER BY position
    """
    return _fetchall_dicts(sql, [round_number, year, year])


def get_constructor_standings(year: int, round_number: int | None = None) -> list[dict]:
    sql = """
        WITH max_round AS (
            SELECT COALESCE(?, MAX(round_number)) AS rnd
            FROM sessions
            WHERE year = ? AND session_key IN (SELECT session_key FROM results)
        ),
        constructor_stats AS (
            SELECT
                s.year,
                r.team AS constructor,
                SUM(COALESCE(r.points, 0)) AS points,
                SUM(CASE WHEN r.position = 1 AND s.session_type = 'R' THEN 1 ELSE 0 END) AS wins
            FROM results r
            JOIN sessions s ON r.session_key = s.session_key
            CROSS JOIN max_round m
            WHERE s.year = ? AND s.round_number <= m.rnd AND r.team IS NOT NULL AND r.team != 'None' AND r.team != ''
            GROUP BY s.year, r.team
        )
        SELECT
            year,
            (SELECT rnd FROM max_round) AS round_number,
            CAST(ROW_NUMBER() OVER(ORDER BY points DESC, wins DESC) AS INTEGER) AS position,
            constructor,
            points,
            CAST(wins AS INTEGER) AS wins
        FROM constructor_stats
        ORDER BY position
    """
    return _fetchall_dicts(sql, [round_number, year, year])


# ── Calendar ───────────────────────────────────────────────────────────

def get_calendar(year: int) -> list[dict]:
    sql = """
        SELECT 
            c.year,
            c.round_number,
            c.event_name,
            c.country,
            c.circuit_name,
            c.event_date,
            c.event_format,
            r_race.driver AS winner,
            r_race.team AS winner_team,
            r_sprint.driver AS sprint_winner,
            r_sprint.team AS sprint_winner_team
        FROM calendar c
        LEFT JOIN sessions s_race ON s_race.year = c.year AND s_race.round_number = c.round_number AND s_race.session_type = 'R'
        LEFT JOIN results r_race ON r_race.session_key = s_race.session_key AND r_race.position = 1
        LEFT JOIN sessions s_sprint ON s_sprint.year = c.year AND s_sprint.round_number = c.round_number AND s_sprint.session_type = 'S'
        LEFT JOIN results r_sprint ON r_sprint.session_key = s_sprint.session_key AND r_sprint.position = 1
        WHERE c.year = ?
        ORDER BY c.round_number
    """
    return _fetchall_dicts(sql, [year])
