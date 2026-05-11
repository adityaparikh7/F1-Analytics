"""
F1 Pitwall — Standings API Router

Championship standings and calendar.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from backend.db import queries

router = APIRouter(tags=["standings"])


@router.get("/standings/drivers")
async def get_driver_standings(
    year: int = Query(..., ge=2018),
    round_number: Optional[int] = None,
):
    """Get driver championship standings for a year (latest round by default)."""
    return queries.get_driver_standings(year, round_number)


@router.get("/standings/constructors")
async def get_constructor_standings(
    year: int = Query(..., ge=2018),
    round_number: Optional[int] = None,
):
    """Get constructor championship standings for a year (latest round by default)."""
    return queries.get_constructor_standings(year, round_number)
