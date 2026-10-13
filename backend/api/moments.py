"""
F1 Pitwall — Race Moments API Router

The race in about ten moments, computed from the ingested laps and results. Cheap (one race's
rows), so not cached. Each moment carries a lap and driver for opening the replay there.
"""

from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, HTTPException

from backend.db import queries
from backend.pipeline.race_moments import compute_race_moments
from backend.pipeline.replay import is_race_session, parse_session_key

router = APIRouter(tags=["moments"])


@router.get("/sessions/{session_key}/race-moments")
async def get_race_moments(session_key: str):
    """
    Key moments of a race or sprint: the start, lead changes, safety cars / VSCs / red flags with
    their cause, retirements, decisive podium passes, the fastest lap and the winning margin; plus
    the leader of every lap, track status periods and headline stats.
    """
    try:
        year, _, session_type = parse_session_key(session_key)
    except ValueError:
        raise HTTPException(400, f"Invalid session_key format: {session_key}")
    if not is_race_session(year, session_type):
        raise HTTPException(400, "Race moments are only available for races and sprints")
    if not queries.session_exists(session_key):
        raise HTTPException(404, f"Session {session_key} not found")

    laps = pd.DataFrame(queries.get_laps(session_key))
    if laps.empty:
        raise HTTPException(404, f"No laps ingested for {session_key}")
    results = pd.DataFrame(queries.get_results(session_key))
    return compute_race_moments(laps, results, session_type, session_key)
