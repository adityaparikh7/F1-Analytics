"""
F1 Pitwall — Tyre Degradation API Router

Phase 1 (shipping): per-session, per-stint degradation fits.
Phase 2 (pending): pooled cross-season model, residuals and circuit severity.

Kept in its own router rather than added to ``sessions.py``, which already mixes sessions,
laps, results, stints, circuit geometry, race control and three ingestion routes.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query

from backend.db import queries
from backend.ml.constants import BAND_POINTS, BOOTSTRAP_ITERATIONS, MIN_CLEAN_LAPS
from backend.ml.degradation import (
    DegradationOptions,
    analyse_session_degradation,
    estimate_field_trend,
)
from backend.ml.stint_models import MODELS

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tyres"])

#: Cache size for computed degradation payloads.
#:
#: Safe to cache because a completed session's laps are immutable once ingested. The one
#: invalidation path is a re-ingest of the same session, which calls :func:`clear_cache`.
#: Caching matters because the residual bootstrap is the expensive step: a driver-filtered
#: request takes ~140 ms, but fitting and bootstrapping all 45 stints of a race takes ~3.8 s,
#: which is worth paying at most once.
_CACHE_SIZE = 32


def clear_cache() -> None:
    """Drop cached degradation payloads. Called after a session is re-ingested."""
    _analyse_cached.cache_clear()


def _parse_csv_option(raw: str | None, valid: set[str], label: str) -> tuple[str, ...]:
    """
    Parse a comma-separated query parameter into a validated tuple.

    An empty string is meaningful and distinct from None: ``?corrections=`` disables every
    correction, which is how a caller compares corrected against raw lap times.
    """
    if raw is None:
        return ()
    if raw.strip() == "":
        return ()
    items = tuple(item.strip().lower() for item in raw.split(",") if item.strip())
    unknown = [item for item in items if item not in valid]
    if unknown:
        raise HTTPException(
            400,
            f"Unknown {label}: {', '.join(unknown)}. Valid: {', '.join(sorted(valid))}",
        )
    return items


@lru_cache(maxsize=_CACHE_SIZE)
def _analyse_cached(
    session_key: str,
    driver: str | None,
    compound: str | None,
    options_key: tuple,
) -> dict:
    """
    Cached inner worker. Arguments are hashable so ``lru_cache`` can key on them.

    The field trend is deliberately computed from the **unfiltered** session even when the
    request is driver-filtered: it describes how the whole field's pace moved over the race,
    and measured on one driver it would describe that driver's race instead.
    """
    options = DegradationOptions(*options_key)
    laps = queries.get_clean_stint_laps(
        session_key,
        driver=driver,
        compound=compound,
        min_clean_laps=options.min_laps,
    )
    if driver or compound:
        reference = queries.get_clean_stint_laps(session_key, min_clean_laps=options.min_laps)
        field_trend = estimate_field_trend(reference)
    else:
        field_trend = estimate_field_trend(laps)

    return analyse_session_degradation(laps, options, field_trend=field_trend)


@router.get("/sessions/{session_key}/tyre-degradation")
async def get_tyre_degradation(
    session_key: str,
    driver: str | None = Query(
        None, description="Three-letter abbreviation (VER) or car number (1)"
    ),
    compound: str | None = Query(None, description="SOFT, MEDIUM or HARD"),
    min_laps: int = Query(MIN_CLEAN_LAPS, ge=3, le=30),
    models: str = Query("linear,quadratic", description="Comma-separated candidate models"),
    corrections: str = Query(
        "fuel", description="Comma-separated corrections; empty string disables all"
    ),
    bootstrap: bool = Query(True, description="Compute the 95% confidence band"),
    band_points: int = Query(BAND_POINTS, ge=10, le=200),
    detail: str = Query("full", pattern="^(full|summary)$"),
):
    """
    Per-stint tyre degradation for one session.

    ``detail=summary`` returns the configuration, per-stint degradation figures and the
    per-compound summary, omitting per-lap points and curve grids — and skipping the
    bootstrap entirely. That is what the dashboard panel requests (~100 ms for a full race).
    ``detail=full`` adds the scatter points and the fitted curve with its confidence band,
    for the analysis page; combine it with *driver* to keep the response fast.

    Degradation is reported as a model-agnostic finite difference over a tyre-life window,
    never as a raw model coefficient — see
    :func:`backend.ml.stint_models.degradation_metric` for why that distinction matters.
    """
    if not queries.session_exists(session_key):
        raise HTTPException(404, f"Session not found: {session_key}")

    model_names = _parse_csv_option(models, set(MODELS), "model")
    if not model_names:
        raise HTTPException(400, "At least one model is required")
    correction_names = _parse_csv_option(
        corrections, {"fuel", "track_temp"}, "correction"
    )

    # Summary responses never need the band, so don't pay for it.
    want_bootstrap = bootstrap and detail == "full"
    options_key = (
        min_laps,
        model_names,
        correction_names,
        want_bootstrap,
        band_points,
        BOOTSTRAP_ITERATIONS,
        detail,
    )

    try:
        return _analyse_cached(
            session_key,
            driver.upper() if driver else None,
            compound.upper() if compound else None,
            options_key,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
