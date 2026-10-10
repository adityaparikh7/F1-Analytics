"""
F1 Pitwall — Lap-Time Corrections

Raw lap times move for reasons that have nothing to do with tyre wear. Before fitting a
degradation curve, those effects are removed so that what remains is attributable to the
tyre. Each effect is a *correction*: a named, self-describing transform that either applies
or reports why it could not.

Two corrections exist:

``fuel``
    Active. The car gets lighter as the race goes on, so lap times fall independently of
    the tyres. Removing this is essential — left in, it cancels much of the degradation
    being measured and makes stints look flatter than they are.

``track_temp``
    Registered but inert. Track temperature is a first-order driver of degradation, but
    ``backend/pipeline/ingest.py`` loads every session with ``weather=False`` and the
    schema has no weather columns, so there is nothing to correct against yet. It is wired
    up regardless, and reports itself as skipped with a reason, so the drop-in path is
    exercised by the tests before the data exists. When weather is ingested, give the laps
    frame a ``track_temp`` column and set a non-zero coefficient; nothing else changes.

Every correction reports whether it ran, so the API can echo ``corrections_applied`` and
``corrections_skipped`` and the UI can state plainly what was and was not accounted for.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from backend.ml.constants import FUEL_S_PER_LAP

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CorrectionResult:
    """Outcome of applying one correction."""

    name: str
    applied: bool
    #: Per-lap adjustment in seconds, already added to the corrected lap time. Zeros when
    #: the correction was skipped, so callers can sum results unconditionally.
    adjustment: np.ndarray
    #: Why it was skipped. None when applied.
    reason: str | None = None
    #: Parameters actually used, for echoing back to the client.
    params: dict = field(default_factory=dict)


def fuel_correction(laps: pd.DataFrame, coef: float = FUEL_S_PER_LAP) -> CorrectionResult:
    """
    Remove the lap-time benefit of burning fuel.

    ``adjustment = coef * lap_number``, **added** to the raw lap time.

    Two details here are the whole point of this function, and both are bugs in the local
    script this ports (``analytics/tyres/tyre-performance-modeling.py:318``):

    **The sign.** Fuel burns off, the car gets lighter, lap times get *faster* as the race
    progresses. To remove a benefit you add the time back. That script subtracts, which
    doubles the effect instead of cancelling it. (Its other branch, keyed on fuel mass
    *remaining* at line 316, legitimately subtracts — the two branches are inconsistent
    with each other, which is how the error survived.)

    **The lap counter.** The correction keys on the absolute ``lap_number``, not on a
    stint-relative lap. Fuel burns monotonically across the whole race and is not
    replenished at a pit stop, so a stint-relative correction resets to zero at every stop
    and systematically under-corrects every stint after the first. Tested by asserting the
    adjustment is monotone *across* a pit stop.

    Note Phase 2 does not use this constant at all: it fits the coefficient freely, which
    on this database recovers -0.0502 s/lap and thereby corroborates the value here.
    """
    if "lap_number" not in laps.columns:
        return CorrectionResult(
            name="fuel",
            applied=False,
            adjustment=np.zeros(len(laps)),
            reason="missing column: lap_number",
        )

    lap_number = pd.to_numeric(laps["lap_number"], errors="coerce").to_numpy(dtype=float)
    if np.isnan(lap_number).all():
        return CorrectionResult(
            name="fuel",
            applied=False,
            adjustment=np.zeros(len(laps)),
            reason="lap_number is entirely non-numeric",
        )

    # ADD time back: see the sign discussion above.
    adjustment = coef * np.nan_to_num(lap_number, nan=0.0)
    return CorrectionResult(
        name="fuel",
        applied=True,
        adjustment=adjustment,
        params={"coef_s_per_lap": coef, "keyed_on": "lap_number"},
    )


def track_temp_correction(laps: pd.DataFrame, coef: float = 0.0) -> CorrectionResult:
    """
    Normalise lap times to the session's mean track temperature.

    ``adjustment = -coef * (track_temp - mean(track_temp))``, so a lap run on a hotter
    track than average has the penalty removed.

    Inert today: no weather data is ingested, so ``track_temp`` is never present and this
    reports itself as skipped. It is kept wired up so that the path from "weather arrives"
    to "degradation is temperature-corrected" is a column plus a coefficient, not a
    redesign — and so the tests can prove that path works now rather than discovering it
    is broken later.
    """
    if "track_temp" not in laps.columns:
        return CorrectionResult(
            name="track_temp",
            applied=False,
            adjustment=np.zeros(len(laps)),
            reason=(
                "missing column: track_temp — the pipeline ingests sessions with "
                "weather=False, so no weather data is stored"
            ),
        )
    if coef == 0.0:
        return CorrectionResult(
            name="track_temp",
            applied=False,
            adjustment=np.zeros(len(laps)),
            reason="coefficient is zero: no track-temperature sensitivity configured",
        )

    temp = pd.to_numeric(laps["track_temp"], errors="coerce").to_numpy(dtype=float)
    if np.isnan(temp).all():
        return CorrectionResult(
            name="track_temp",
            applied=False,
            adjustment=np.zeros(len(laps)),
            reason="track_temp is entirely non-numeric",
        )

    mean_temp = float(np.nanmean(temp))
    adjustment = -coef * np.nan_to_num(temp - mean_temp, nan=0.0)
    return CorrectionResult(
        name="track_temp",
        applied=True,
        adjustment=adjustment,
        params={"coef_s_per_degree": coef, "mean_track_temp": mean_temp},
    )


#: Correction registry, applied in this order. Adding a correction means adding it here.
CORRECTIONS: dict[str, Callable[..., CorrectionResult]] = {
    "fuel": fuel_correction,
    "track_temp": track_temp_correction,
}


def apply_corrections(
    laps: pd.DataFrame,
    names: Sequence[str] = ("fuel",),
    lap_time_column: str = "lap_time",
) -> tuple[np.ndarray, list[CorrectionResult]]:
    """
    Apply the named corrections and return ``(corrected_lap_times, results)``.

    Unknown names are reported as skipped rather than raised, so a stale client query
    string degrades into a visible note instead of a 500. Passing an empty *names* returns
    the raw lap times untouched, which the API exposes as ``?corrections=`` for comparison.
    """
    base = pd.to_numeric(laps[lap_time_column], errors="coerce").to_numpy(dtype=float)
    corrected = base.copy()
    results: list[CorrectionResult] = []

    for name in names:
        fn = CORRECTIONS.get(name)
        if fn is None:
            results.append(
                CorrectionResult(
                    name=name,
                    applied=False,
                    adjustment=np.zeros(len(laps)),
                    reason=f"unknown correction (known: {', '.join(sorted(CORRECTIONS))})",
                )
            )
            continue
        result = fn(laps)
        results.append(result)
        if result.applied:
            corrected = corrected + result.adjustment

    return corrected, results


def describe_corrections(results: Sequence[CorrectionResult]) -> tuple[list[dict], list[dict]]:
    """Split correction results into JSON-ready ``(applied, skipped)`` lists for the API."""
    applied = [
        {"name": r.name, **r.params} for r in results if r.applied
    ]
    skipped = [
        {"name": r.name, "reason": r.reason} for r in results if not r.applied
    ]
    return applied, skipped
