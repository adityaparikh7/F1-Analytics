"""
Pytest configuration for the F1 Pitwall backend.

Two things here are load-bearing. Read both before changing them.

**1. The sys.path shim.** The code imports itself as ``backend.api.main`` — that is, the
importable package is ``backend``, whose parent is the repo root — which is why CLAUDE.md
insists the app is run from the repo root. ``backend/pyproject.toml`` installs dependencies
only (see its ``[tool.setuptools]`` comment), so nothing puts ``backend`` on ``sys.path``
for us. The insert below does it, which makes ``cd backend && python -m pytest`` work.

**2. The environment variables are set at import time, not in a fixture.** ``backend.config``
resolves every path and calls ``mkdir`` *at module import*, so by the time a fixture body
runs it is already too late — the real ``data/`` directories would have been touched, and
``DUCKDB_PATH`` would point at the real 29 MB database. pytest imports this file before any
test module, so setting them here is early enough.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# 1. Repo root on sys.path, so `import backend.*` resolves.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# 2. Redirect every filesystem path away from the real project before backend.config loads.
#    The guardrail in CLAUDE.md is that data/ and cache/ are expensive, git-ignored feature
#    stores; a test run must not write into them.
_TMP = Path(tempfile.mkdtemp(prefix="pitwall-tests-"))
os.environ.setdefault("DUCKDB_PATH", str(_TMP / "test.duckdb"))
os.environ.setdefault("MODELS_DIR", str(_TMP / "models"))
os.environ.setdefault("PARQUET_DATA_DIR", str(_TMP / "parquet"))
os.environ.setdefault("FASTF1_CACHE_DIR", str(_TMP / "cache"))

import duckdb  # noqa: E402
import pytest  # noqa: E402

from backend.db import connection as db_connection  # noqa: E402
from backend.db.schema import SCHEMA_SQL  # noqa: E402
from backend.tests.fixtures.seed_laps import SEED_SESSIONS, seed_lap_rows  # noqa: E402


@pytest.fixture
def duckdb_conn(monkeypatch):
    """
    An in-memory DuckDB seeded with the real schema and a small hand-written lap set.

    The monkeypatch target matters: ``backend/db/queries.py`` does
    ``from backend.db.connection import get_connection``, which binds the *function object*
    at import time. Patching ``backend.db.connection.get_connection`` therefore has no
    effect on the name ``queries`` already holds. Patching the ``_connection`` module global
    does work, because ``get_connection()`` returns it when it is not None. Someone will
    otherwise lose an hour to this.
    """
    conn = duckdb.connect(":memory:")
    conn.execute(SCHEMA_SQL)

    for row in SEED_SESSIONS:
        conn.execute(
            "INSERT INTO sessions (session_key, year, round_number, event_name, country, "
            "circuit_name, session_type, date, total_laps) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
    for row in seed_lap_rows():
        conn.execute(
            "INSERT INTO laps (session_key, driver, driver_number, team, lap_number, "
            "lap_time, sector1_time, sector2_time, sector3_time, compound, tyre_life, "
            "stint, is_personal_best, is_pit_out_lap, is_pit_in_lap, track_status, position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )

    monkeypatch.setattr(db_connection, "_connection", conn)
    yield conn
    monkeypatch.setattr(db_connection, "_connection", None)
    conn.close()
