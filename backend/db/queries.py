"""
F1 Pitwall — DuckDB Query Functions

Reusable query helpers that return data as lists of dicts (JSON-ready).
"""

from __future__ import annotations

import logging

import numpy as np

from backend.db.connection import get_connection

logger = logging.getLogger(__name__)


def _fetchall_dicts(sql: str, params: list | None = None) -> list[dict]:
    """Execute a query and return results as a list of dicts."""
    conn = get_connection()
    result = conn.execute(sql, params or []).fetchdf()
    return result.replace({np.nan: None}).to_dict(orient="records")


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
        if driver.isdigit():
            sql += " AND driver_number = ?"
            params.append(int(driver))
        else:
            sql += " AND driver = ?"
            params.append(driver.upper())
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
        if driver.isdigit():
            sql += " AND driver_number = ?"
            params.append(int(driver))
        else:
            sql += " AND driver = ?"
            params.append(driver.upper())
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
