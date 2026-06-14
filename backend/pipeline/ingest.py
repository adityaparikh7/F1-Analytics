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
    """Extract session results, write Parquet, and insert into DuckDB.

    Handles all session types:
    - Race / Sprint: standard finishing order with gap computation
    - Qualifying / Sprint Qualifying: Q1, Q2, Q3 times
    - Practice (FP1-FP3): best lap per driver and gap to quickest
    """
    try:
        results = session.results
    except Exception:
        logger.warning("No results available for %s", session_key)
        return

    if results is None or (hasattr(results, "empty") and results.empty):
        logger.warning("Empty results for %s", session_key)
        return

    # Determine session type from key (e.g. "2025_06_Q" → "Q")
    session_type = session_key.rsplit("_", 1)[-1]
    is_qualifying = session_type in ("Q", "SQ", "SS")
    is_practice = session_type in ("FP1", "FP2", "FP3")

    # ── Base columns (common to all session types) ─────────────────
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
        "gap_to_leader": None,
        "fastest_lap": None,
        "fastest_lap_number": None,
        "pit_stops": None,
        "q1_time": None,
        "q2_time": None,
        "q3_time": None,
        "best_lap_time": None,
    })

    # ── Qualifying-specific: Q1 / Q2 / Q3 times ───────────────────
    if is_qualifying:
        for col, target in [("Q1", "q1_time"), ("Q2", "q2_time"), ("Q3", "q3_time")]:
            if col in results.columns:
                df[target] = results[col].apply(_safe_timedelta_to_seconds).values

        # Best lap is the best of Q1/Q2/Q3
        q_cols = [c for c in ["q1_time", "q2_time", "q3_time"] if df[c].notna().any()]
        if q_cols:
            df["best_lap_time"] = df[q_cols].min(axis=1)

        # Gap to leader based on best qualifying lap
        leader_time = df["best_lap_time"].min()
        if leader_time is not None and not pd.isna(leader_time):
            gaps = []
            for _, row in df.iterrows():
                t = row["best_lap_time"]
                if t is not None and not pd.isna(t):
                    delta = t - leader_time
                    gaps.append(f"+{delta:.3f}" if delta > 0 else "Leader")
                else:
                    gaps.append(None)
            df["gap_to_leader"] = gaps

        # Ensure position is set (FastF1 provides it for qualifying)
        # If position column is empty, order by best_lap_time
        if df["position"].isna().all() and df["best_lap_time"].notna().any():
            df = df.sort_values("best_lap_time", na_position="last")
            df["position"] = range(1, len(df) + 1)

    # ── Practice-specific: best lap per driver ─────────────────────
    elif is_practice:
        try:
            laps = session.laps
            if not laps.empty:
                # Get the best lap for each driver
                best_laps = (
                    laps.groupby("Driver")
                    .apply(lambda d: d.loc[d["LapTime"].idxmin()] if d["LapTime"].notna().any() else None)
                    .dropna(how="all")
                )
                if not best_laps.empty:
                    best_map = {}
                    for _, row in best_laps.iterrows():
                        drv = str(row["Driver"])
                        lt = _safe_timedelta_to_seconds(row["LapTime"])
                        best_map[drv] = lt

                    df["best_lap_time"] = df["driver"].map(best_map)

                    # Compute position by best lap time
                    df = df.sort_values("best_lap_time", na_position="last")
                    df["position"] = range(1, len(df) + 1)

                    # Gap to leader
                    leader_time = df["best_lap_time"].min()
                    if leader_time is not None and not pd.isna(leader_time):
                        gaps = []
                        for _, row in df.iterrows():
                            t = row["best_lap_time"]
                            if t is not None and not pd.isna(t):
                                delta = t - leader_time
                                gaps.append(f"+{delta:.3f}" if delta > 0 else "Leader")
                            else:
                                gaps.append(None)
                        df["gap_to_leader"] = gaps
        except Exception as exc:
            logger.warning("Failed to compute practice results for %s: %s", session_key, exc)

    # ── Race / Sprint: compute gap from time column ────────────────
    else:
        times = df["time"].values
        if times is not None and len(times) > 0:
            leader_time = None
            gaps = []
            for t in times:
                if t is not None and not pd.isna(t):
                    if leader_time is None:
                        leader_time = t
                        gaps.append("Leader")
                    else:
                        gaps.append(f"+{t - leader_time:.3f}")
                else:
                    gaps.append(None)
            df["gap_to_leader"] = gaps

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
) -> tuple[str, list[dict]]:
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
    
    if driver_laps.empty:
        raise ValueError(f"No laps found for driver {driver}")
    real_driver = driver_laps.iloc[0]["Driver"]

    if lap == "fastest":
        selected_lap = driver_laps.pick_fastest()
    elif lap == "personal_best":
        selected_lap = driver_laps.pick_fastest()  # Same as fastest for single driver
    else:
        selected_lap = driver_laps[driver_laps["LapNumber"] == int(lap)].iloc[0]

    try:
        telemetry = selected_lap.get_telemetry()
    except Exception:
        telemetry = selected_lap.get_car_data().add_distance()
        telemetry["X"] = None
        telemetry["Y"] = None

    df = pd.DataFrame({
        "distance": telemetry["Distance"].values if "Distance" in telemetry.columns else None,
        "time": (telemetry["Time"] - telemetry["Time"].iloc[0]).dt.total_seconds().values if "Time" in telemetry.columns else None,
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
    return real_driver, df.to_dict(orient="records")

def fetch_circuit_info(
    year: int,
    round_number: int | None = None,
    event: str | None = None,
    session_type: str = "R",
) -> list[dict]:
    """Fetch corner data for a given circuit."""
    _init_fastf1()

    identifier = round_number if round_number is not None else event
    session = fastf1.get_session(year, identifier, session_type)
    session.load(laps=True, telemetry=True, weather=False, messages=False)

    try:
        circuit_info = session.get_circuit_info()
        corners = circuit_info.corners
        if corners.empty:
            return []

        df = pd.DataFrame({
            "number": pd.to_numeric(corners["Number"], errors="coerce").astype("Int64"),
            "letter": corners.get("Letter").astype(str) if "Letter" in corners.columns else None,
            "angle": corners.get("Angle").values if "Angle" in corners.columns else None,
            "distance": corners.get("Distance").values if "Distance" in corners.columns else None,
        })
        df = df.replace({np.nan: None})
        return df.to_dict(orient="records")
    except Exception as exc:
        logger.warning("Failed to fetch circuit info: %s", exc)
        return []

# ── Auto Ingestion ─────────────────────────────────────────────────────────

def sync_season_sessions(year: int) -> None:
    """Check a specific season's schedule and ingest any completed sessions missing from DB."""
    import datetime
    
    _init_fastf1()
    
    now_utc = pd.Timestamp.utcnow()
    conn = get_connection()
    
    # Map from FastF1 session name to short code
    # We only auto-ingest points-awarding sessions (Sprint and Race) to preserve the 500 calls/hr rate limit
    session_map = {
        # "Practice 1": "FP1",
        # "Practice 2": "FP2",
        # "Practice 3": "FP3",
        # "Qualifying": "Q",
        # "Sprint Qualifying": "SQ",
        # "Sprint Shootout": "SQ",
        "Sprint": "S",
        "Race": "R",
    }
    
    # Pre-fetch all ingested session keys to avoid repeated queries
    try:
        existing_keys = {row[0] for row in conn.execute("SELECT session_key FROM sessions").fetchall()}
    except Exception:
        existing_keys = set()
    
    try:
        schedule = fastf1.get_event_schedule(year, include_testing=False)
    except Exception as e:
        logger.warning("Failed to fetch schedule for %s: %s", year, e)
        return
        
    for _, event in schedule.iterrows():
        round_number = event.get("RoundNumber")
        if pd.isna(round_number) or int(round_number) == 0:
            continue
            
        round_number = int(round_number)
        
        # Check all 5 possible session columns in the schedule
        for i in range(1, 6):
            session_name_col = f"Session{i}"
            session_date_col = f"Session{i}DateUtc"
            
            if session_name_col in event and session_date_col in event:
                session_name = event.get(session_name_col)
                session_date = event.get(session_date_col)
                
                if pd.isna(session_name) or pd.isna(session_date) or not session_name:
                    continue
                    
                short_code = session_map.get(session_name)
                if not short_code:
                    continue
                    
                session_time = pd.Timestamp(session_date)
                if session_time.tzinfo is None:
                    session_time = session_time.tz_localize('UTC')
                    
                # If session started more than 3 hours ago
                if now_utc > session_time + pd.Timedelta(hours=3):
                    session_key = _make_session_key(year, round_number, short_code)
                    if session_key not in existing_keys:
                        logger.info("Auto-ingesting missing session: %s", session_key)
                        try:
                            ingest_session(year, round_number, None, short_code)
                            existing_keys.add(session_key)
                        except Exception as e:
                            logger.error("Failed to auto-ingest %s: %s", session_key, e)

