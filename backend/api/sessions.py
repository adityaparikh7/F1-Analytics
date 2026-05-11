"""
F1 Pitwall — Sessions API Router

Endpoints for sessions, laps, results, and stints.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from backend.db import queries
from backend.pipeline.ingest import ingest_session, ingest_calendar

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sessions"])


# ── Sessions ───────────────────────────────────────────────────────────

@router.get("/sessions")
async def list_sessions(year: Optional[int] = None):
    """List all ingested sessions, optionally filtered by year."""
    return queries.list_sessions(year)


@router.get("/sessions/{session_key}")
async def get_session(session_key: str):
    """Get metadata for a specific session."""
    session = queries.get_session(session_key)
    if not session:
        raise HTTPException(404, f"Session not found: {session_key}")
    return session


@router.get("/sessions/{session_key}/results")
async def get_session_results(session_key: str):
    """Get classified results for a session."""
    if not queries.session_exists(session_key):
        raise HTTPException(404, f"Session not found: {session_key}")
    return queries.get_results(session_key)


@router.get("/sessions/{session_key}/laps")
async def get_session_laps(
    session_key: str,
    driver: Optional[str] = None,
    compound: Optional[str] = None,
    exclude_pit_laps: bool = False,
):
    """Get lap data for a session, with optional filters."""
    if not queries.session_exists(session_key):
        raise HTTPException(404, f"Session not found: {session_key}")
    return queries.get_laps(session_key, driver, compound, exclude_pit_laps)


@router.get("/sessions/{session_key}/stints")
async def get_session_stints(
    session_key: str,
    driver: Optional[str] = None,
):
    """Get stint summary for a session."""
    if not queries.session_exists(session_key):
        raise HTTPException(404, f"Session not found: {session_key}")
    return queries.get_stints(session_key, driver)


# ── Ingestion ──────────────────────────────────────────────────────────

@router.post("/sessions/ingest")
async def trigger_ingest(
    background_tasks: BackgroundTasks,
    year: int = Query(..., ge=2018),
    round_number: Optional[int] = None,
    event: Optional[str] = None,
    session_type: str = Query("R", pattern="^(FP1|FP2|FP3|Q|SQ|S|SS|R)$"),
):
    """Trigger ETL for a session. Runs in the background."""
    if round_number is None and event is None:
        raise HTTPException(400, "Provide either round_number or event")

    background_tasks.add_task(
        ingest_session,
        year=year,
        round_number=round_number,
        event=event,
        session_type=session_type,
    )

    return {
        "status": "ingestion_started",
        "year": year,
        "round_number": round_number,
        "event": event,
        "session_type": session_type,
    }


@router.post("/calendar/ingest")
async def trigger_calendar_ingest(
    background_tasks: BackgroundTasks,
    year: int = Query(..., ge=2018),
):
    """Fetch and store the season calendar."""
    background_tasks.add_task(ingest_calendar, year)
    return {"status": "calendar_ingestion_started", "year": year}


@router.get("/calendar")
async def get_calendar(year: int = Query(..., ge=2018)):
    """Get the season calendar."""
    return queries.get_calendar(year)
