"""
F1 Pitwall — Backend Configuration

All paths are relative to the project root (one level above backend/).
Environment variables can override defaults.
"""

from __future__ import annotations

import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = Path(os.getenv("FASTF1_CACHE_DIR", str(PROJECT_ROOT / "cache" / "fastf1")))
PARQUET_DIR = Path(os.getenv("PARQUET_DATA_DIR", str(PROJECT_ROOT / "data" / "parquet")))
DUCKDB_PATH = Path(os.getenv("DUCKDB_PATH", str(PROJECT_ROOT / "data" / "pitwall.duckdb")))

# ── API ────────────────────────────────────────────────────────────────
API_HOST = os.getenv("API_HOST", "0.0.0.0")
API_PORT = int(os.getenv("API_PORT", "8000"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

# ── Data ───────────────────────────────────────────────────────────────
MIN_SEASON = 2018  # Earliest season with reliable FastF1 data
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# ── Parquet subdirectories ─────────────────────────────────────────────
PARQUET_SESSIONS_DIR = PARQUET_DIR / "sessions"
PARQUET_LAPS_DIR = PARQUET_DIR / "laps"
PARQUET_TELEMETRY_DIR = PARQUET_DIR / "telemetry"
PARQUET_RESULTS_DIR = PARQUET_DIR / "results"
PARQUET_STANDINGS_DIR = PARQUET_DIR / "standings"

# ── Ensure directories exist ───────────────────────────────────────────
for _dir in [CACHE_DIR, PARQUET_SESSIONS_DIR, PARQUET_LAPS_DIR,
             PARQUET_TELEMETRY_DIR, PARQUET_RESULTS_DIR, PARQUET_STANDINGS_DIR]:
    _dir.mkdir(parents=True, exist_ok=True)
