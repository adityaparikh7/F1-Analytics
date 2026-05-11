"""
F1 Pitwall — DuckDB Schema Definition

Creates tables and views for the feature store.
Tables are materialised from Parquet files; views provide convenient access.
"""

from __future__ import annotations

import logging

from backend.db.connection import get_connection

logger = logging.getLogger(__name__)

# ── Schema SQL ─────────────────────────────────────────────────────────

SCHEMA_SQL = """
-- Sessions metadata
CREATE TABLE IF NOT EXISTS sessions (
    session_key     VARCHAR PRIMARY KEY,
    year            INTEGER NOT NULL,
    round_number    INTEGER,
    event_name      VARCHAR NOT NULL,
    country         VARCHAR,
    circuit_name    VARCHAR,
    session_type    VARCHAR NOT NULL,     -- FP1, FP2, FP3, Q, SQ, S, SS, R
    date            DATE,
    total_laps      INTEGER,
    data_quality    VARCHAR DEFAULT 'full'  -- full, partial, minimal
);

-- Lap-level timing data
CREATE TABLE IF NOT EXISTS laps (
    session_key     VARCHAR NOT NULL,
    driver          VARCHAR NOT NULL,
    driver_number   INTEGER,
    team            VARCHAR,
    lap_number      INTEGER NOT NULL,
    lap_time        DOUBLE,              -- seconds
    sector1_time    DOUBLE,
    sector2_time    DOUBLE,
    sector3_time    DOUBLE,
    compound        VARCHAR,             -- SOFT, MEDIUM, HARD, INTERMEDIATE, WET
    tyre_life       INTEGER,
    stint           INTEGER,
    is_personal_best BOOLEAN,
    is_pit_out_lap  BOOLEAN,
    is_pit_in_lap   BOOLEAN,
    track_status    VARCHAR,
    position        INTEGER,
    PRIMARY KEY (session_key, driver, lap_number)
);

-- Session results (classified finishing order)
CREATE TABLE IF NOT EXISTS results (
    session_key     VARCHAR NOT NULL,
    driver          VARCHAR NOT NULL,
    driver_number   INTEGER,
    team            VARCHAR,
    position        INTEGER,
    grid_position   INTEGER,
    status          VARCHAR,             -- Finished, +1 Lap, DNF, etc.
    points          DOUBLE,
    time            DOUBLE,              -- total race time in seconds
    gap_to_leader   VARCHAR,             -- formatted gap string
    fastest_lap     DOUBLE,              -- fastest lap time in seconds
    fastest_lap_number INTEGER,
    pit_stops       INTEGER,
    PRIMARY KEY (session_key, driver)
);

-- Championship standings
CREATE TABLE IF NOT EXISTS driver_standings (
    year            INTEGER NOT NULL,
    round_number    INTEGER NOT NULL,
    position        INTEGER NOT NULL,
    driver          VARCHAR NOT NULL,
    driver_number   INTEGER,
    team            VARCHAR,
    points          DOUBLE,
    wins            INTEGER,
    PRIMARY KEY (year, round_number, driver)
);

CREATE TABLE IF NOT EXISTS constructor_standings (
    year            INTEGER NOT NULL,
    round_number    INTEGER NOT NULL,
    position        INTEGER NOT NULL,
    constructor     VARCHAR NOT NULL,
    points          DOUBLE,
    wins            INTEGER,
    PRIMARY KEY (year, round_number, constructor)
);

-- Season calendar
CREATE TABLE IF NOT EXISTS calendar (
    year            INTEGER NOT NULL,
    round_number    INTEGER NOT NULL,
    event_name      VARCHAR NOT NULL,
    country         VARCHAR,
    circuit_name    VARCHAR,
    event_date      DATE,
    event_format    VARCHAR,             -- conventional, sprint_shootout, sprint_qualifying, testing
    PRIMARY KEY (year, round_number)
);
"""


def initialise_schema() -> None:
    """Create all tables if they don't exist."""
    conn = get_connection()
    conn.execute(SCHEMA_SQL)
    logger.info("DuckDB schema initialised")


def refresh_parquet_views() -> None:
    """
    Create or replace views that read directly from Parquet directories.
    These are useful for ad-hoc queries outside the normal table flow.
    """
    conn = get_connection()
    from backend.config import (
        PARQUET_LAPS_DIR,
        PARQUET_RESULTS_DIR,
        PARQUET_STANDINGS_DIR,
    )

    for name, path in [
        ("v_laps", PARQUET_LAPS_DIR),
        ("v_results", PARQUET_RESULTS_DIR),
        ("v_standings", PARQUET_STANDINGS_DIR),
    ]:
        parquet_glob = str(path / "*.parquet")
        try:
            conn.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet('{parquet_glob}')")
            logger.debug("Created view %s", name)
        except Exception:
            # No parquet files yet — that's fine
            logger.debug("No parquet files for view %s yet", name)
