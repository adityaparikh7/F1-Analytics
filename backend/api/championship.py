"""
F1 Pitwall — Championship API Router

Points progression, who-can-still-win elimination and Monte Carlo title odds for one season.
The maths lives in :mod:`backend.ml.championship`; this layer fetches the season's results and
calendar and turns the model's ValueErrors into 400s.

Nothing is cached. A projection is one small query plus well under 100 ms of NumPy at the
default 10,000 simulations, and the fixed default seed already makes repeated requests return
identical odds — a cache would only add an invalidation path to keep in step with ingestion.
"""

from __future__ import annotations

import logging
from typing import Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.db import queries
from backend.ml import championship
from backend.ml.championship import Pin, SimulationOptions

logger = logging.getLogger(__name__)

router = APIRouter(tags=["championship"])

_MIN_SIMS, _MAX_SIMS = 1_000, 50_000
_MIN_FORM, _MAX_FORM = 3, 30


def _season_results(year: int) -> pd.DataFrame:
    results = queries.get_season_results(year)
    if results.empty:
        raise HTTPException(404, f"No race or sprint results ingested for {year}")
    return results


@router.get("/championship/progression")
async def get_championship_progression(year: int = Query(..., ge=2018)):
    """Cumulative points and championship position after every round, drivers and constructors."""
    results = _season_results(year)
    return championship.season_progression(year, results, queries.get_calendar(year))


@router.get("/championship/projection")
async def get_championship_projection(
    year: int = Query(..., ge=2018),
    as_of_round: int | None = Query(
        None,
        ge=1,
        description="Project from this round. Earlier than the latest ingested round replays the "
        "projection as it stood then, alongside what actually happened.",
    ),
    n_sims: int = Query(championship.DEFAULT_N_SIMS, ge=_MIN_SIMS, le=_MAX_SIMS),
    form_window: int = Query(championship.DEFAULT_FORM_WINDOW, ge=_MIN_FORM, le=_MAX_FORM),
    seed: int = Query(0, ge=0),
):
    """Title odds, elimination and projected points trajectories for a season."""
    return _project(year, as_of_round, n_sims, form_window, seed, pins=[])


class PinRequest(BaseModel):
    round_number: int = Field(..., ge=1)
    session_type: Literal["R", "S"]
    driver: str = Field(..., min_length=1, max_length=3, description="Abbreviation (VER) or car number (1)")
    position: int | None = Field(None, ge=1, description="Finishing position; null for a DNF")


class ProjectionRequest(BaseModel):
    year: int = Field(..., ge=2018)
    as_of_round: int | None = Field(None, ge=1)
    n_sims: int = Field(championship.DEFAULT_N_SIMS, ge=_MIN_SIMS, le=_MAX_SIMS)
    form_window: int = Field(championship.DEFAULT_FORM_WINDOW, ge=_MIN_FORM, le=_MAX_FORM)
    seed: int = Field(0, ge=0)
    pins: list[PinRequest] = Field(default_factory=list, max_length=500)


@router.post("/championship/projection")
async def simulate_championship_scenario(request: ProjectionRequest):
    """
    The projection with what-if results pinned in every simulated season.

    Pinned and baseline projections share their random draws, so with the same seed the
    difference between the two responses is caused by the pins alone.
    """
    pins = [Pin(p.round_number, p.session_type, p.driver, p.position) for p in request.pins]
    return _project(request.year, request.as_of_round, request.n_sims, request.form_window, request.seed, pins)


def _project(
    year: int,
    as_of_round: int | None,
    n_sims: int,
    form_window: int,
    seed: int,
    pins: list[Pin],
) -> dict:
    results = _season_results(year)
    options = SimulationOptions(n_sims=n_sims, form_window=form_window, seed=seed)
    try:
        return championship.project_championship(
            year, results, queries.get_calendar(year), as_of_round, options, pins
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
