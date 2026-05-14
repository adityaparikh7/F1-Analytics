"""
F1 Pitwall — ETL Ingestion Pipeline

Fetches session data from FastF1, normalises it, writes Parquet files,
and loads into DuckDB. Telemetry is handled on-demand (not batch).
"""

from __future__ import annotations

import logging
from datetime import datetime

import fastf1
import numpy as np
import pandas as pd

from backend.config import (
    CACHE_DIR,
    PARQUET_LAPS_DIR,
    PARQUET_RESULTS_DIR,
    PARQUET_STANDINGS_DIR,
)
from backend.db.connection import get_connection

logger = logging.getLogger(__name__)

# ── FastF1 cache setup ─────────────────────────────────────────────────
_FASTF1_INITIALIZED = False


def _init_fastf1() -> None:
    global _FASTF1_INITIALIZED
    if _FASTF1_INITIALIZED:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(str(CACHE_DIR))
    _FASTF1_INITIALIZED = True


def _make_session_key(year: int, round_number: int, session_type: str) -> str:
    """Generate a unique session key, e.g. '2025_06_R'."""
    return f"{year}_{round_number:02d}_{session_type}"


def _safe_timedelta_to_seconds(td) -> float | None:
    """Convert a pandas Timedelta to seconds, handling NaT."""
    if pd.isna(td):
        return None
    try:
        return td.total_seconds()
    except Exception:
        return None


# ── Session ingestion ──────────────────────────────────────────────────

def ingest_session(
    year: int,
    round_number: int | None = None,
    event: str | None = None,
    session_type: str = "R",
    on_progress: callable = None,
) -> str:
    """
    Ingest a single session into the feature store.

    Args:
        year: Season year
        round_number: Round number (preferred) or None
        event: Event name (used if round_number not provided)
        session_type: Session code (FP1, FP2, FP3, Q, SQ, S, SS, R)
        on_progress: Optional callback for progress updates

    Returns:
        session_key for the ingested session
    """
    _init_fastf1()

    def _progress(msg: str):
        logger.info(msg)
        if on_progress:
            on_progress(msg)

    _progress(f"Loading session: {year} round={round_number or event} type={session_type}")

    # Load session from FastF1
    identifier = round_number if round_number is not None else event
    session = fastf1.get_session(year, identifier, session_type)
    session.load(laps=True, telemetry=False, weather=False, messages=False)

    # Determine round number from the loaded session
    actual_round = int(session.event["RoundNumber"])
    session_key = _make_session_key(year, actual_round, session_type)

    _progress(f"Session loaded: {session.event['EventName']} — {session.name}")

    # ── Store session metadata ─────────────────────────────────────
    _store_session_metadata(session, session_key, year, actual_round, session_type)
    _progress("Session metadata stored")

    # ── Store lap data ─────────────────────────────────────────────
    _store_laps(session, session_key)
    _progress("Lap data stored")

    # ── Store results ──────────────────────────────────────────────
    _store_results(session, session_key)
    _progress("Results stored")

    _progress(f"Ingestion complete: {session_key}")
    return session_key


def _store_session_metadata(session, session_key: str, year: int, round_number: int, session_type: str):
    """Insert or replace session metadata in DuckDB."""
    conn = get_connection()
    event = session.event

    total_laps = None
    try:
        total_laps = int(session.total_laps) if hasattr(session, "total_laps") and session.total_laps else None
    except Exception:
        pass

    session_date = None
    try:
        if hasattr(session, "date") and session.date is not None:
            session_date = pd.Timestamp(session.date).strftime("%Y-%m-%d")
    except Exception:
        pass

    conn.execute(
        """
        INSERT OR REPLACE INTO sessions
        (session_key, year, round_number, event_name, country, circuit_name, session_type, date, total_laps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            session_key,
            year,
            round_number,
            str(event.get("EventName", "")),
            str(event.get("Country", "")),
            str(event.get("Location", "")),
            session_type,
            session_date,
            total_laps,
        ],
    )


def _store_laps(session, session_key: str):
    """Extract lap data, write Parquet, and insert into DuckDB."""
    laps = session.laps

    if laps.empty:
        logger.warning("No lap data for %s", session_key)
        return

    df = pd.DataFrame({
        "session_key": session_key,
        "driver": laps["Driver"].astype(str),
        "driver_number": pd.to_numeric(laps["DriverNumber"], errors="coerce").astype("Int64"),
        "team": laps["Team"].astype(str) if "Team" in laps.columns else None,
        "lap_number": laps["LapNumber"].astype(int),
        "lap_time": laps["LapTime"].apply(_safe_timedelta_to_seconds),
        "sector1_time": laps["Sector1Time"].apply(_safe_timedelta_to_seconds) if "Sector1Time" in laps.columns else None,
        "sector2_time": laps["Sector2Time"].apply(_safe_timedelta_to_seconds) if "Sector2Time" in laps.columns else None,
        "sector3_time": laps["Sector3Time"].apply(_safe_timedelta_to_seconds) if "Sector3Time" in laps.columns else None,
        "compound": laps["Compound"].astype(str) if "Compound" in laps.columns else None,
        "tyre_life": pd.to_numeric(laps.get("TyreLife"), errors="coerce").astype("Int64") if "TyreLife" in laps.columns else None,
        "stint": pd.to_numeric(laps.get("Stint"), errors="coerce").astype("Int64") if "Stint" in laps.columns else None,
        "is_personal_best": laps.get("IsPersonalBest") if "IsPersonalBest" in laps.columns else None,
        "is_pit_out_lap": laps.get("PitOutTime").notna() if "PitOutTime" in laps.columns else False,
        "is_pit_in_lap": laps.get("PitInTime").notna() if "PitInTime" in laps.columns else False,
        "track_status": laps.get("TrackStatus").astype(str) if "TrackStatus" in laps.columns else None,
        "position": pd.to_numeric(laps.get("Position"), errors="coerce").astype("Int64") if "Position" in laps.columns else None,
    })

    # Replace numpy NaN / NaT with None for clean Parquet output
    df = df.replace({np.nan: None})

    # Write Parquet
    parquet_path = PARQUET_LAPS_DIR / f"{session_key}.parquet"
    df.to_parquet(parquet_path, index=False)
    logger.info("Wrote %d laps to %s", len(df), parquet_path)

    # Insert into DuckDB
    conn = get_connection()
    conn.execute(f"DELETE FROM laps WHERE session_key = '{session_key}'")
    conn.execute("INSERT INTO laps SELECT * FROM read_parquet(?)", [str(parquet_path)])


def _store_results(session, session_key: str):
    """Extract session results, write Parquet, and insert into DuckDB."""
    try:
        results = session.results
    except Exception:
        logger.warning("No results available for %s", session_key)
        return

    if results is None or (hasattr(results, "empty") and results.empty):
        logger.warning("Empty results for %s", session_key)
        return

    df = pd.DataFrame({
        "session_key": session_key,
        "driver": results["Abbreviation"].astype(str),
        "driver_number": pd.to_numeric(results["DriverNumber"], errors="coerce").astype("Int64"),
        "team": results["TeamName"].astype(str) if "TeamName" in results.columns else None,
        "position": pd.to_numeric(results.get("Position"), errors="coerce").astype("Int64"),
        "grid_position": pd.to_numeric(results.get("GridPosition"), errors="coerce").astype("Int64") if "GridPosition" in results.columns else None,
        "status": results.get("Status").astype(str) if "Status" in results.columns else None,
        "points": pd.to_numeric(results.get("Points"), errors="coerce") if "Points" in results.columns else None,
        "time": results.get("Time").apply(_safe_timedelta_to_seconds) if "Time" in results.columns else None,
        "gap_to_leader": None,  # Will be computed from time deltas
        "fastest_lap": None,    # FastF1 doesn't always have this in results
        "fastest_lap_number": None,
        "pit_stops": None,
    })

    df = df.replace({np.nan: None})

    parquet_path = PARQUET_RESULTS_DIR / f"{session_key}.parquet"
    df.to_parquet(parquet_path, index=False)
    logger.info("Wrote %d results to %s", len(df), parquet_path)

    conn = get_connection()
    conn.execute(f"DELETE FROM results WHERE session_key = '{session_key}'")
    conn.execute("INSERT INTO results SELECT * FROM read_parquet(?)", [str(parquet_path)])


# ── Calendar & Standings ───────────────────────────────────────────────

def ingest_calendar(year: int) -> None:
    """Fetch and store the season calendar."""
    _init_fastf1()
    schedule = fastf1.get_event_schedule(year, include_testing=False)

    conn = get_connection()
    conn.execute("DELETE FROM calendar WHERE year = ?", [year])

    for _, event in schedule.iterrows():
        if pd.isna(event.get("RoundNumber")) or int(event["RoundNumber"]) == 0:
            continue
        event_date = None
        try:
            event_date = pd.Timestamp(event.get("EventDate")).strftime("%Y-%m-%d")
        except Exception:
            pass

        conn.execute(
            """
            INSERT INTO calendar (year, round_number, event_name, country, circuit_name, event_date, event_format)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                year,
                int(event["RoundNumber"]),
                str(event.get("EventName", "")),
                str(event.get("Country", "")),
                str(event.get("Location", "")),
                event_date,
                str(event.get("EventFormat", "conventional")),
            ],
        )

    logger.info("Ingested calendar for %d (%d rounds)", year, len(schedule))


# ── Telemetry (on-demand) ──────────────────────────────────────────────

def fetch_telemetry(
    year: int,
    round_number: int | None = None,
    event: str | None = None,
    session_type: str = "R",
    driver: str = "VER",
    lap: str = "fastest",
) -> list[dict]:
    """
    Fetch telemetry data on-demand (not stored in DuckDB permanently).

    Args:
        lap: "fastest", "personal_best", or a lap number as string
    """
    _init_fastf1()

    identifier = round_number if round_number is not None else event
    session = fastf1.get_session(year, identifier, session_type)
    session.load(laps=True, telemetry=True, weather=False, messages=False)

    driver_laps = session.laps.pick_drivers(driver)

    if lap == "fastest":
        selected_lap = driver_laps.pick_fastest()
    elif lap == "personal_best":
        selected_lap = driver_laps.pick_fastest()  # Same as fastest for single driver
    else:
        selected_lap = driver_laps[driver_laps["LapNumber"] == int(lap)].iloc[0]

    telemetry = selected_lap.get_car_data().add_distance()

    # Also get position data for track map
    try:
        pos_data = selected_lap.get_pos_data()
        telemetry = telemetry.merge(
            pos_data[["Date", "X", "Y"]],
            on="Date",
            how="left",
        )
    except Exception:
        telemetry["X"] = None
        telemetry["Y"] = None

    df = pd.DataFrame({
        "distance": telemetry["Distance"].values if "Distance" in telemetry.columns else None,
        "speed": telemetry["Speed"].values if "Speed" in telemetry.columns else None,
        "throttle": telemetry["Throttle"].values if "Throttle" in telemetry.columns else None,
        "brake": telemetry["Brake"].values if "Brake" in telemetry.columns else None,
        "gear": telemetry["nGear"].values if "nGear" in telemetry.columns else None,
        "rpm": telemetry["RPM"].values if "RPM" in telemetry.columns else None,
        "drs": telemetry["DRS"].values if "DRS" in telemetry.columns else None,
        "x": telemetry["X"].values if "X" in telemetry.columns else None,
        "y": telemetry["Y"].values if "Y" in telemetry.columns else None,
    })

    df = df.replace({np.nan: None})
    return df.to_dict(orient="records")
