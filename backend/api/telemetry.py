"""
F1 Pitwall — Telemetry API Router

On-demand telemetry fetching — not batch ingested.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.pipeline.ingest import fetch_telemetry

logger = logging.getLogger(__name__)

router = APIRouter(tags=["telemetry"])


@router.get("/sessions/{session_key}/telemetry")
async def get_telemetry(
    session_key: str,
    driver: str = Query(..., min_length=1, max_length=3),
    lap: str = Query("fastest"),
    downsample: Optional[int] = Query(None, ge=1, le=100, description="Take every Nth point"),
):
    """
    Fetch telemetry for a specific driver and lap.

    - `driver`: 3-letter driver abbreviation (e.g. VER, HAM) or driver number (e.g. 1, 44)
    - `lap`: "fastest", "personal_best", or a lap number
    - `downsample`: optional, return every Nth sample for performance

    Telemetry is fetched on-demand from FastF1 (cached after first fetch).
    """
    # Parse session_key → year, round, type
    try:
        parts = session_key.split("_")
        year = int(parts[0])
        round_number = int(parts[1])
        session_type = parts[2]
    except (ValueError, IndexError):
        raise HTTPException(400, f"Invalid session_key format: {session_key}")

    try:
        real_driver, data = fetch_telemetry(
            year=year,
            round_number=round_number,
            session_type=session_type,
            driver=driver.upper(),
            lap=lap,
        )
    except Exception as exc:
        logger.error("Telemetry fetch failed: %s", exc, exc_info=True)
        raise HTTPException(500, f"Failed to fetch telemetry: {exc}")

    if downsample and downsample > 1:
        data = data[::downsample]

    return {
        "session_key": session_key,
        "driver": real_driver,
        "lap": lap,
        "sample_count": len(data),
        "data": data,
    }
