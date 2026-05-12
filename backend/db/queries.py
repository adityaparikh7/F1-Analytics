"""
F1 Pitwall — DuckDB Query Functions

Reusable query helpers that return data as lists of dicts (JSON-ready).
"""

from __future__ import annotations

import logging

from backend.db.connection import get_connection

logger = logging.getLogger(__name__)


def _fetchall_dicts(sql: str, params: list | None = None) -> list[dict]:
    """Execute a query and return results as a list of dicts."""
    conn = get_connection()
    result = conn.execute(sql, params or []).fetchdf()
    return result.to_dict(orient="records")


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

    if driver:
        sql += " AND driver = ?"
        params.append(driver)
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
    if driver:
        sql += " AND driver = ?"
        params.append(driver)
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
    if round_number is not None:
        sql = "SELECT * FROM driver_standings WHERE year = ? AND round_number = ? ORDER BY position"
        return _fetchall_dicts(sql, [year, round_number])
    # Latest round
    sql = """
        SELECT * FROM driver_standings
        WHERE year = ? AND round_number = (
            SELECT MAX(round_number) FROM driver_standings WHERE year = ?
        )
        ORDER BY position
    """
    return _fetchall_dicts(sql, [year, year])


def get_constructor_standings(year: int, round_number: int | None = None) -> list[dict]:
    if round_number is not None:
        sql = "SELECT * FROM constructor_standings WHERE year = ? AND round_number = ? ORDER BY position"
        return _fetchall_dicts(sql, [year, round_number])
    sql = """
        SELECT * FROM constructor_standings
        WHERE year = ? AND round_number = (
            SELECT MAX(round_number) FROM constructor_standings WHERE year = ?
        )
        ORDER BY position
    """
    return _fetchall_dicts(sql, [year, year])


# ── Calendar ───────────────────────────────────────────────────────────

def get_calendar(year: int) -> list[dict]:
    return _fetchall_dicts(
        "SELECT * FROM calendar WHERE year = ? ORDER BY round_number",
        [year],
    )
