"""
F1 Pitwall — DuckDB Connection Manager

Provides a singleton DuckDB connection and schema initialisation.
All tables are created as views over Parquet files for zero-copy reads.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb

from backend.config import DUCKDB_PATH, PARQUET_DIR

logger = logging.getLogger(__name__)

_connection: duckdb.DuckDBPyConnection | None = None


def get_connection() -> duckdb.DuckDBPyConnection:
    """Return the singleton DuckDB connection, creating it if needed."""
    global _connection
    if _connection is None:
        DUCKDB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _connection = duckdb.connect(str(DUCKDB_PATH))
        logger.info("DuckDB connection opened: %s", DUCKDB_PATH)
    return _connection


def close_connection() -> None:
    """Close the DuckDB connection."""
    global _connection
    if _connection is not None:
        _connection.close()
        _connection = None
        logger.info("DuckDB connection closed")
