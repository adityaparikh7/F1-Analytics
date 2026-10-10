"""
A hand-written miniature season for the championship tests.

Four drivers in two teams over a five-round 2022 calendar (2022 rules: sprint 8…1, fastest-lap
point), with sprint weekends at rounds 2 and 4 and a pre-season test the schedule must skip.
Rounds 1–3 are "ingested"; Sprint 4, Race 4 and Race 5 are still to run.

Small enough to check every expected number by hand:

    cumulative   R1   R2 (S+R)   R3
    AAA          25   50         75     wins R1 and R3
    CCC          18   51         66     wins R2, and leads after round 2
    BBB          15   32         50
    DDD          12   33         45

    Alpha (AAA + BBB)   40   82   125
    Beta  (CCC + DDD)   30   84   111   leads after round 2

Still to win: 8 + 26 + 26 = 60 points per driver, 15 + 44 + 44 = 103 per team.
"""

from __future__ import annotations

import pandas as pd

YEAR = 2022

#: (session_key, year, round_number, event_name, country, circuit_name, session_type, date,
#:  total_laps) — the same column order as conftest's sessions INSERT.
SEASON_SESSIONS: list[tuple] = [
    ("2022_01_R", 2022, 1, "Alpha Grand Prix", "Aland", "Alpha Ring", "R", "2022-03-20", 50),
    ("2022_02_S", 2022, 2, "Beta Grand Prix", "Bland", "Beta Park", "S", "2022-04-02", 20),
    ("2022_02_R", 2022, 2, "Beta Grand Prix", "Bland", "Beta Park", "R", "2022-04-03", 50),
    ("2022_03_R", 2022, 3, "Gamma Grand Prix", "Cland", "Gamma Street", "R", "2022-04-17", 50),
]

#: driver -> (car number, team)
DRIVERS: dict[str, tuple[int, str]] = {
    "AAA": (1, "Alpha"),
    "BBB": (2, "Alpha"),
    "CCC": (3, "Beta"),
    "DDD": (4, "Beta"),
}

#: session_key -> finishing order with the published points.
_FINISHES: dict[str, list[tuple[str, float]]] = {
    "2022_01_R": [("AAA", 25), ("CCC", 18), ("BBB", 15), ("DDD", 12)],
    "2022_02_S": [("CCC", 8), ("AAA", 7), ("DDD", 6), ("BBB", 5)],
    "2022_02_R": [("CCC", 25), ("AAA", 18), ("DDD", 15), ("BBB", 12)],
    "2022_03_R": [("AAA", 25), ("BBB", 18), ("CCC", 15), ("DDD", 12)],
}

#: (year, round_number, event_name, country, circuit_name, event_date, event_format)
SEASON_CALENDAR: list[tuple] = [
    (2022, 0, "Pre-Season Testing", "Tland", "Test Track", "2022-03-01", "testing"),
    (2022, 1, "Alpha Grand Prix", "Aland", "Alpha Ring", "2022-03-20", "conventional"),
    (2022, 2, "Beta Grand Prix", "Bland", "Beta Park", "2022-04-03", "sprint"),
    (2022, 3, "Gamma Grand Prix", "Cland", "Gamma Street", "2022-04-17", "conventional"),
    (2022, 4, "Delta Grand Prix", "Dland", "Delta Raceway", "2022-05-01", "sprint"),
    (2022, 5, "Epsilon Grand Prix", "Eland", "Epsilon Circuit", "2022-05-15", "conventional"),
]

_CALENDAR_COLUMNS = ("year", "round_number", "event_name", "country", "circuit_name", "event_date", "event_format")


def season_result_rows() -> list[tuple]:
    """``(session_key, driver, driver_number, team, position, status, points)`` per finisher."""
    rows = []
    for session_key, finishes in _FINISHES.items():
        for position, (driver, points) in enumerate(finishes, start=1):
            number, team = DRIVERS[driver]
            rows.append((session_key, driver, number, team, position, "Finished", float(points)))
    return rows


def season_results_frame() -> pd.DataFrame:
    """The season shaped like ``queries.get_season_results``, for tests that skip the database."""
    sessions = {row[0]: row for row in SEASON_SESSIONS}
    records = []
    for session_key, driver, number, team, position, status, points in season_result_rows():
        _, _, round_number, event_name, _, _, session_type, _, _ = sessions[session_key]
        records.append(
            {
                "round_number": round_number,
                "session_type": session_type,
                "event_name": event_name,
                "driver": driver,
                "driver_number": number,
                "team": team,
                "position": position,
                "status": status,
                "points": points,
            }
        )
    return pd.DataFrame(records)


def season_calendar() -> list[dict]:
    """The calendar shaped like ``queries.get_calendar``."""
    return [dict(zip(_CALENDAR_COLUMNS, row)) for row in SEASON_CALENDAR]


def seed_season(conn) -> None:
    """Insert the miniature season into a connection that already has the schema."""
    for row in SEASON_SESSIONS:
        conn.execute(
            "INSERT INTO sessions (session_key, year, round_number, event_name, country, "
            "circuit_name, session_type, date, total_laps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
    for row in season_result_rows():
        conn.execute(
            "INSERT INTO results (session_key, driver, driver_number, team, position, status, points) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            row,
        )
    for row in SEASON_CALENDAR:
        conn.execute(
            "INSERT INTO calendar (year, round_number, event_name, country, circuit_name, event_date, "
            "event_format) VALUES (?, ?, ?, ?, ?, ?, ?)",
            row,
        )
