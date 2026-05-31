"""
F1 Pitwall — Telemetry API Router

On-demand telemetry fetching — not batch ingested.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
import fastf1
import pandas as pd
import numpy as np

from backend.pipeline.ingest import fetch_telemetry, _init_fastf1

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


@router.get("/sessions/{session_key}/top-speeds")
async def get_top_speeds(
    session_key: str,
    top_n: int = Query(15, ge=1, le=50)
):
    """
    Get top speeds for all drivers in a session.
    Returns the top N speeds and average speed per driver.
    """
    try:
        parts = session_key.split("_")
        year = int(parts[0])
        round_number = int(parts[1])
        session_type = parts[2]
    except (ValueError, IndexError):
        raise HTTPException(400, f"Invalid session_key format: {session_key}")

    try:
        _init_fastf1()
        session = fastf1.get_session(year, round_number, session_type)
        session.load(telemetry=True, laps=True, weather=False, messages=False)

        source = "telemetry"
        if hasattr(session, "laps") and not session.laps.empty:
            if ('SpeedST' in session.laps.columns) and (pd.to_numeric(session.laps['SpeedST'], errors='coerce').notna().any()):
                source = "speedtrap"

        rows = []
        for drv in session.drivers:
            info = session.get_driver(drv)
            label = info.get('Abbreviation', drv)

            lap_speeds = []
            if source == "speedtrap":
                laps = session.laps.pick_drivers(drv)
                vals = pd.to_numeric(laps['SpeedST'], errors='coerce')
                lap_speeds = [float(v) for v in vals.dropna().tolist() if np.isfinite(v) and v > 50.0]
            else:
                laps = session.laps.pick_drivers(drv)
                for _, lap in laps.iterlaps():
                    try:
                        car_data = lap.get_car_data()
                        if car_data is None or car_data.empty:
                            continue
                        vmax = float(car_data['Speed'].max())
                        if np.isfinite(vmax) and vmax > 50:
                            lap_speeds.append(vmax)
                    except Exception:
                        continue

            if not lap_speeds:
                vals = [None] * top_n + [None]
            else:
                sorted_desc = sorted(lap_speeds, reverse=True)
                top_vals = sorted_desc[:top_n]
                if len(top_vals) < top_n:
                    top_vals = top_vals + [None] * (top_n - len(top_vals))
                avg_val = float(np.mean(lap_speeds))
                vals = top_vals + [avg_val]

            rows.append({
                "driver": label,
                "top_speeds": vals[:-1],
                "average": vals[-1],
                "best": vals[0]
            })

        rows = sorted(rows, key=lambda x: (x["best"] or 0, x["average"] or 0), reverse=True)

        return {
            "source": source,
            "data": rows
        }
    except Exception as exc:
        logger.error("Top speeds fetch failed: %s", exc, exc_info=True)
        raise HTTPException(500, f"Failed to fetch top speeds: {exc}")
