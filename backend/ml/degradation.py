"""
F1 Pitwall — Phase 1: Per-Session Tyre Degradation

Orchestrates one session's worth of per-stint degradation fits and assembles the JSON-ready
payload the API serves.

Pipeline per stint:

    clean laps (SQL predicate)
      -> corrections (fuel; track temperature pending weather ingestion)
      -> MAD outlier rejection
      -> fit linear and quadratic, select by AICc
      -> model-agnostic degradation metric over a tyre-life window
      -> residual bootstrap confidence band
      -> cliff detection, cross-stint anomaly z-score

This layer is descriptive: it reports what each stint did, and makes no cross-session or
causal claim. The pooled model in ``pooled_model.py`` is what adds "and was that better or
worse than expected".
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from backend.ml.constants import (
    ANOMALY_Z_THRESHOLD,
    BAND_POINTS,
    BOOTSTRAP_ITERATIONS,
    FIELD_TREND_WARN_S,
    FUEL_S_PER_LAP,
    MIN_CLEAN_LAPS,
    NOMINAL_WINDOW,
)
from backend.ml.corrections import apply_corrections, describe_corrections
from backend.ml.stint_models import (
    bootstrap_band,
    degradation_metric,
    detect_cliff,
    mad_outlier_mask,
    select_model,
)

logger = logging.getLogger(__name__)

DEFAULT_MODELS = ("linear", "quadratic")
DEFAULT_CORRECTIONS = ("fuel",)


@dataclass
class DegradationOptions:
    """Knobs for one degradation request, mirroring the endpoint's query parameters."""

    min_laps: int = MIN_CLEAN_LAPS
    models: tuple[str, ...] = DEFAULT_MODELS
    corrections: tuple[str, ...] = DEFAULT_CORRECTIONS
    bootstrap: bool = True
    band_points: int = BAND_POINTS
    bootstrap_iterations: int = BOOTSTRAP_ITERATIONS
    #: ``"full"`` embeds per-lap points and the curve grid; ``"summary"`` omits both. The
    #: dashboard panel asks for summary, the analysis page for full.
    detail: str = "full"


def estimate_field_trend(laps: pd.DataFrame) -> float | None:
    """
    Slope of the field's median lap time against lap number, in seconds per lap.

    Diagnostic, not a correction. ``lap_number`` carries three monotone effects that cannot
    be separated from it alone — fuel burn-off (faster), track evolution (faster), and the
    field's average tyre degradation (slower) — so this number is their sum, and a negative
    value means the field got faster over the race.

    It is reported because it calibrates the fuel constant and exposes sessions where that
    constant does not fit. Across 58 races in this database the median field trend is
    -0.0566 s/lap, which is almost exactly ``FUEL_S_PER_LAP`` (0.055) and independently
    close to the -0.0502 the pooled model fits freely. Three measurements agreeing is why
    the fuel correction is trusted and why no separate track-evolution correction is
    applied: subtracting this trend instead of the fuel constant moves per-compound median
    degradation by less than 0.003 s/lap.

    Individual sessions do deviate. Madrid 2026 runs -0.0817 s/lap — a brand-new circuit
    rubbering in — and there absolute degradation is biased low. Hence the warning raised in
    :func:`analyse_session_degradation` rather than a silent adjustment.

    Requires an unfiltered session: computed over a single driver's laps it measures that
    driver's race, not the field's.
    """
    if laps.empty or laps["lap_number"].nunique() < 5:
        return None
    median_by_lap = laps.groupby("lap_number")["lap_time"].median()
    if len(median_by_lap) < 5:
        return None
    slope = np.polyfit(
        median_by_lap.index.to_numpy(dtype=float),
        median_by_lap.to_numpy(dtype=float),
        1,
    )[0]
    return float(slope)


def _round(value: float | None, digits: int = 4) -> float | None:
    """Round for JSON, mapping non-finite values to None so the payload stays valid JSON."""
    if value is None:
        return None
    value = float(value)
    if not np.isfinite(value):
        return None
    return round(value, digits)


def analyse_session_degradation(
    laps: pd.DataFrame,
    options: DegradationOptions | None = None,
    field_trend: float | None = None,
) -> dict[str, Any]:
    """
    Fit every stint in *laps* and assemble the response payload.

    *laps* is the output of :func:`backend.db.queries.get_clean_stint_laps` — already
    filtered to clean laps in sufficiently long stints, with ``session_median_lap_time`` and
    ``clean_lap_count`` attached. Takes a frame rather than a session key so that it stays
    testable without a database.

    *field_trend* is :func:`estimate_field_trend` computed over the **unfiltered** session.
    Pass it explicitly when *laps* is driver- or compound-filtered, since the trend is a
    property of the field rather than of one driver; it is only used to warn about sessions
    where the fuel constant fits poorly.
    """
    options = options or DegradationOptions()
    warnings: list[str] = []

    if laps.empty:
        return {
            "session_key": None,
            "config": _describe_config(options, [], laps, field_trend),
            "stints": [],
            "compound_summary": [],
            "warnings": ["No clean laps available for this session."],
        }

    if field_trend is None:
        field_trend = estimate_field_trend(laps)

    first = laps.iloc[0]
    corrected, correction_results = apply_corrections(laps, names=options.corrections)
    laps = laps.copy()
    laps["lap_time_corrected"] = corrected

    stints: list[dict[str, Any]] = []
    skipped_short = 0

    for (driver, stint_number), group in laps.groupby(["driver", "stint"], sort=False):
        group = group.sort_values("tyre_life")
        record = _fit_one_stint(driver, int(stint_number), group, options)
        if record is None:
            skipped_short += 1
            continue
        stints.append(record)

    if skipped_short:
        warnings.append(
            f"{skipped_short} stint(s) skipped: fewer than {options.min_laps} clean laps "
            f"remained after outlier rejection."
        )

    warnings.extend(_field_trend_warnings(field_trend, options))

    _attach_anomaly_scores(stints)
    stints.sort(key=lambda s: (s["driver"], s["stint"]))

    return {
        "session_key": str(first.get("session_key")),
        "event_name": _optional_str(first.get("event_name")),
        "circuit_name": _optional_str(first.get("circuit_name")),
        "session_type": _optional_str(first.get("session_type")),
        "year": int(first["year"]) if pd.notna(first.get("year")) else None,
        "session_median_lap_time": _round(first.get("session_median_lap_time"), 3),
        "config": _describe_config(options, correction_results, laps, field_trend),
        "stints": stints,
        "compound_summary": _compound_summary(stints),
        "warnings": warnings,
    }


def _field_trend_warnings(
    field_trend: float | None,
    options: DegradationOptions,
) -> list[str]:
    """
    Warn when this session's field trend is far from the fuel constant.

    The fuel correction assumes the field gets faster at roughly ``FUEL_S_PER_LAP``. That
    holds on a typical race — the median field trend across 58 races is -0.0566 against a
    constant of 0.055 — but not on every one. Where it does not, every stint's absolute
    degradation is biased by the difference, and the honest response is to say so rather
    than to silently adjust, because the trend also contains the field's own average tyre
    degradation and subtracting it wholesale would remove part of the signal.
    """
    if field_trend is None or "fuel" not in options.corrections:
        return []

    residual = field_trend + FUEL_S_PER_LAP
    if abs(residual) <= FIELD_TREND_WARN_S:
        return []

    direction = "understate" if residual < 0 else "overstate"
    return [
        f"This session's field pace trend is {field_trend:+.4f} s/lap against an assumed "
        f"fuel effect of {FUEL_S_PER_LAP:.3f} s/lap, leaving {residual:+.4f} s/lap "
        f"unaccounted for — most likely track evolution. Absolute degradation figures for "
        f"this session probably {direction} the true rate by about that much; comparisons "
        f"between stints within the session are unaffected."
    ]


def _optional_str(value: Any) -> str | None:
    return None if value is None or pd.isna(value) else str(value)


def _fit_one_stint(
    driver: str,
    stint_number: int,
    group: pd.DataFrame,
    options: DegradationOptions,
) -> dict[str, Any] | None:
    """Fit a single stint, or return None when too little clean data survives."""
    n_total = len(group)
    keep = mad_outlier_mask(group["lap_time_corrected"].to_numpy(dtype=float))
    clean = group.loc[keep]

    if len(clean) < options.min_laps:
        return None

    tyre_life = clean["tyre_life"].to_numpy(dtype=float)
    y = clean["lap_time_corrected"].to_numpy(dtype=float)

    best, all_fits = select_model(tyre_life, y, options.models)
    metric = degradation_metric(best, tyre_life, window=NOMINAL_WINDOW)
    cliff = detect_cliff(best, tyre_life)

    record: dict[str, Any] = {
        "driver": str(driver),
        "driver_number": _optional_int(group["driver_number"].iloc[0]),
        "team": _optional_str(group["team"].iloc[0]),
        "stint": stint_number,
        "compound": _optional_str(group["compound"].iloc[0]),
        "start_lap": int(group["lap_number"].min()),
        "end_lap": int(group["lap_number"].max()),
        "tyre_life_start": int(group["tyre_life"].min()),
        "tyre_life_end": int(group["tyre_life"].max()),
        "n_laps_total": n_total,
        "n_laps_clean": int(len(clean)),
        "n_laps_dropped_outlier": int(n_total - len(clean)),
        "model": best.model,
        "converged": best.converged,
        "params": [_round(p, 6) for p in best.params],
        "param_names": list(best.param_names),
        "fit": {
            "rss": _round(best.rss),
            "rmse": _round(best.rmse),
            "r2": _round(best.r2),
            "aicc": _round(best.aicc, 3),
        },
        "model_comparison": [
            {
                "model": f.model,
                "k": len(f.param_names),
                "aicc": _round(f.aicc, 3),
                "rmse": _round(f.rmse),
                "selected": f.model == best.model,
            }
            for f in all_fits
        ],
        "degradation": {
            "s_per_lap": _round(metric.s_per_lap),
            "se_s_per_lap": _round(metric.se_s_per_lap),
            # False means the stint shows no degradation distinguishable from a flat line.
            # The UI must not rank or headline these: a noisy fit produces extreme values, so
            # unfiltered they sort straight to the top.
            "significant": metric.significant,
            "window_lo": metric.window_lo,
            "window_hi": metric.window_hi,
            "window_source": metric.window_source,
            "comparable": metric.comparable,
            "s_per_lap_full_range": _round(metric.s_per_lap_full_range),
            "full_range_lo": metric.full_range_lo,
            "full_range_hi": metric.full_range_hi,
        },
        "cliff_tyre_life": _round(cliff, 2),
        # Filled in by _attach_anomaly_scores once every stint is known.
        "anomaly": None,
    }

    if options.detail == "full":
        band = (
            bootstrap_band(
                tyre_life, y, best,
                n_points=options.band_points,
                iterations=options.bootstrap_iterations,
            )
            if options.bootstrap
            else bootstrap_band(
                tyre_life, y, best, n_points=options.band_points, iterations=0
            )
        )
        record["laps"] = _lap_records(group, keep)
        record["curve"] = _curve_records(band)

    return record


def _optional_int(value: Any) -> int | None:
    return None if value is None or pd.isna(value) else int(value)


def _lap_records(group: pd.DataFrame, keep: np.ndarray) -> list[dict[str, Any]]:
    """
    Per-lap points for the scatter, including the laps rejected as outliers.

    Rejected laps are returned flagged rather than dropped, so the page can show them
    de-emphasised — a scatter that silently omits points invites the reader to assume the fit
    saw everything, and seeing what was excluded is how you tell a sound fit from a
    convenient one.
    """
    records = []
    for (_, row), kept in zip(group.iterrows(), keep, strict=True):
        records.append(
            {
                "lap_number": int(row["lap_number"]),
                "tyre_life": int(row["tyre_life"]),
                "lap_time": _round(row["lap_time"], 3),
                "lap_time_corrected": _round(row["lap_time_corrected"], 3),
                "is_outlier": not bool(kept),
            }
        )
    return records


def _curve_records(band) -> list[dict[str, Any]]:
    """Curve grid, with band bounds as None when the bootstrap was skipped or failed."""
    has_band = band.lo is not None and band.hi is not None
    return [
        {
            "tyre_life": _round(band.tyre_life[i], 3),
            "fit": _round(band.fit[i], 3),
            "lo": _round(band.lo[i], 3) if has_band else None,
            "hi": _round(band.hi[i], 3) if has_band else None,
        }
        for i in range(len(band.tyre_life))
    ]


def _attach_anomaly_scores(stints: list[dict[str, Any]]) -> None:
    """
    Flag stints whose degradation is unusual for their compound.

    Peers are grouped by ``compound`` **and** ``window_source``: a degradation measured over
    tyre life 1-9 is not comparable with one measured over 5-15, so pooling them would make
    every short soft stint look anomalous for a reason that is an artefact of measurement.
    ``peer_group`` is reported so the grouping is visible rather than implied.

    Mutates *stints* in place.
    """
    buckets: dict[str, list[dict[str, Any]]] = {}
    for stint in stints:
        degradation = stint["degradation"]
        if degradation["s_per_lap"] is None or not degradation["comparable"]:
            continue
        key = f"{stint['compound']}:{degradation['window_source']}"
        buckets.setdefault(key, []).append(stint)

    for key, members in buckets.items():
        values = np.array([m["degradation"]["s_per_lap"] for m in members], dtype=float)
        if len(values) < 2:
            continue
        mean = float(np.mean(values))
        std = float(np.std(values, ddof=1))
        for member, value in zip(members, values, strict=True):
            z = 0.0 if std == 0.0 else float((value - mean) / std)
            member["anomaly"] = {
                "z_score": _round(z, 3),
                "is_anomalous": abs(z) > ANOMALY_Z_THRESHOLD,
                "peer_group": key,
                "peer_count": len(members),
            }


def _compound_summary(stints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Per-compound degradation distribution for this session.

    Only ``comparable`` stints contribute, and the window source is reported, so the summary
    cannot silently mix measurement bases. This is what the dashboard panel displays.
    """
    by_compound: dict[str, list[dict[str, Any]]] = {}
    for stint in stints:
        by_compound.setdefault(stint["compound"] or "UNKNOWN", []).append(stint)

    summary = []
    for compound, members in by_compound.items():
        usable = [
            m["degradation"]["s_per_lap"]
            for m in members
            if m["degradation"]["comparable"] and m["degradation"]["s_per_lap"] is not None
        ]
        sources = {
            m["degradation"]["window_source"]
            for m in members
            if m["degradation"]["comparable"]
        }
        entry: dict[str, Any] = {
            "compound": compound,
            "n_stints": len(members),
            "n_stints_comparable": len(usable),
            "window_sources": sorted(sources),
            "median_deg_s_per_lap": None,
            "p25_deg_s_per_lap": None,
            "p75_deg_s_per_lap": None,
        }
        if usable:
            values = np.array(usable, dtype=float)
            entry["median_deg_s_per_lap"] = _round(np.median(values))
            entry["p25_deg_s_per_lap"] = _round(np.percentile(values, 25))
            entry["p75_deg_s_per_lap"] = _round(np.percentile(values, 75))
        summary.append(entry)

    summary.sort(key=lambda e: (e["median_deg_s_per_lap"] is None, e["compound"]))
    return summary


def _describe_config(
    options: DegradationOptions,
    correction_results,
    laps: pd.DataFrame,
    field_trend: float | None = None,
) -> dict[str, Any]:
    """Echo back exactly what was computed, so the UI can state its own caveats."""
    applied, skipped = describe_corrections(correction_results)
    return {
        "min_laps": options.min_laps,
        "models": list(options.models),
        "detail": options.detail,
        "corrections_applied": applied,
        "corrections_skipped": skipped,
        "nominal_window": list(NOMINAL_WINDOW),
        "bootstrap": options.bootstrap,
        "bootstrap_iterations": options.bootstrap_iterations if options.bootstrap else 0,
        "n_clean_laps": int(len(laps)),
        # Diagnostic: the sum of fuel burn-off, track evolution and the field's own average
        # degradation. Reported so a session with unusual track evolution is visible rather
        # than quietly shifting every degradation figure. See estimate_field_trend.
        "field_trend_s_per_lap": _round(field_trend),
    }
