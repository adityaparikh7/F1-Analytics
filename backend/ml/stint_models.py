"""
F1 Pitwall — Stint Degradation Models

Pure maths for fitting a single tyre stint. No database, no HTTP, no pandas dependency in
the core functions — arrays in, dataclasses out — so this module is cheap to test
exhaustively, which matters because two of the functions here exist specifically to stop
known bugs from being reintroduced.

The model of a stint's lap times against tyre age:

    linear      L(t) = L0 + c*t
    quadratic   L(t) = L0 + c1*t + c2*t^2

where ``t`` is ``tyre_life`` (the ingested column, which correctly tracks age across
scrubbed and used sets) and ``L`` is the *corrected* lap time.

A warm-up model, ``L0 + a(1 - e^{-bt}) + ct``, is physically well motivated and is
deliberately **not** offered. AICc selects it for essentially no real stints — on 462
fittable 2026 race stints the counts were linear 260, quadratic 202, warm-up 0 — because
stints are too short to identify a fourth parameter. Adding it back means adding it to
MODELS below; nothing else needs to change, because parameters are handled as
variable-length arrays throughout.

The single most important function here is :func:`degradation_metric`. Read its docstring
before changing how degradation is reported.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares
from scipy.stats import median_abs_deviation

from backend.ml.constants import (
    BAND_HI_PCT,
    BAND_LO_PCT,
    BAND_POINTS,
    BOOTSTRAP_ITERATIONS,
    CLIFF_THRESHOLD,
    MAD_THRESHOLD,
    MAD_ZERO_FLOOR_S,
    MAX_FEV,
    MIN_WINDOW_SPAN,
    NOMINAL_WINDOW,
    ROBUST_F_SCALE,
    ROBUST_LOSS,
    SIGNIFICANCE_SIGMA,
)

logger = logging.getLogger(__name__)


# ── Model functions ────────────────────────────────────────────────────

def linear_model(t: np.ndarray, l0: float, c: float) -> np.ndarray:
    """``L(t) = L0 + c*t`` — constant degradation rate."""
    return l0 + c * t


def quadratic_model(t: np.ndarray, l0: float, c1: float, c2: float) -> np.ndarray:
    """``L(t) = L0 + c1*t + c2*t^2`` — accelerating (or easing) degradation."""
    return l0 + c1 * t + c2 * t**2


@dataclass(frozen=True)
class ModelSpec:
    """A candidate model: its function, parameter names, and initial guess builder."""

    name: str
    func: Callable[..., np.ndarray]
    param_names: tuple[str, ...]

    @property
    def n_params(self) -> int:
        return len(self.param_names)

    def initial_guess(self, t: np.ndarray, y: np.ndarray) -> list[float]:
        median_y = float(np.median(y))
        if self.name == "linear":
            return [median_y, 0.05]
        return [median_y, 0.05, 0.0]

    def design_matrix(self, t: np.ndarray) -> np.ndarray:
        """
        Design matrix rows for *t*.

        Both models are *linear in their parameters* — the quadratic is curved in tyre life
        but still a linear combination of ``1, t, t^2``. That is what makes the degradation
        standard error in :func:`degradation_metric` exact rather than an approximation, and
        it is why adding a genuinely non-linear model (such as the exponential warm-up term)
        would require switching that calculation to the delta method.
        """
        t = np.asarray(t, dtype=float)
        columns = [np.ones_like(t), t]
        if self.n_params == 3:
            columns.append(t**2)
        return np.column_stack(columns)


MODELS: dict[str, ModelSpec] = {
    "linear": ModelSpec("linear", linear_model, ("l0", "c")),
    "quadratic": ModelSpec("quadratic", quadratic_model, ("l0", "c1", "c2")),
}


# ── Outlier rejection ──────────────────────────────────────────────────

def mad_outlier_mask(y: np.ndarray, threshold: float = MAD_THRESHOLD) -> np.ndarray:
    """
    Boolean mask of laps to KEEP, by median absolute deviation from the stint median.

    ``scale="normal"`` makes the MAD comparable to a standard deviation, so *threshold* is
    interpretable as "sigmas" despite being a robust statistic.

    Adapted from ``analytics/tyres/tyre-performance-modeling.py:283-289``, with its fallback
    chain **deliberately shortened**. That script falls back ``MAD -> std -> 0.5`` when the
    MAD is zero; this one falls back ``MAD -> MAD_ZERO_FLOOR_S`` and drops the ``std`` rung,
    because that rung is actively harmful in precisely the situation that triggers it.

    A MAD of exactly zero means at least half the lap times are identical to the median, so
    the only values contributing spread are the minority — that is, the outliers. Handing
    them ``std`` lets them set their own acceptance threshold. Concretely: for ten laps at
    90.0 s plus one at 120.0 s, the MAD is 0 and the std is 8.62, so the threshold becomes
    4 x 8.62 = 34.5 s and the 30 s outlier is *kept*. With the fixed floor the threshold is
    4 x 0.5 = 2.0 s and it is correctly rejected, while a genuinely uniform stint still has
    every lap kept because its deviations are all zero.
    """
    y = np.asarray(y, dtype=float)
    if y.size == 0:
        return np.zeros(0, dtype=bool)

    median = float(np.median(y))
    mad = float(median_abs_deviation(y, scale="normal"))
    if mad == 0.0:
        mad = MAD_ZERO_FLOOR_S

    return np.abs(y - median) < threshold * mad


# ── Fitting ────────────────────────────────────────────────────────────

@dataclass
class StintFit:
    """One fitted model for one stint."""

    model: str
    params: np.ndarray
    param_names: tuple[str, ...]
    aicc: float
    rss: float
    rmse: float
    r2: float
    n_points: int
    converged: bool

    def predict(self, t: np.ndarray | float) -> np.ndarray:
        return MODELS[self.model].func(np.asarray(t, dtype=float), *self.params)


def aicc(y: np.ndarray, y_hat: np.ndarray, n_params: int) -> float:
    """
    Akaike Information Criterion with the small-sample correction.

    The ``2k(k+1)/(n-k-1)`` term is not optional here: stints provide 8-25 points, which is
    squarely in the regime where plain AIC under-penalises the extra parameter and would
    pick the quadratic almost always. Ported from
    ``analytics/tyres/tyre-performance-modeling.py:395-402``.

    Returns ``inf`` when the criterion is undefined (too few points, or a perfect fit),
    which makes the model simply lose the ``min()`` comparison.
    """
    y = np.asarray(y, dtype=float)
    n = y.size
    rss = float(np.sum((y - np.asarray(y_hat, dtype=float)) ** 2))
    if rss <= 0.0 or n - n_params - 1 <= 0:
        return float("inf")
    base = n * np.log(rss / n) + 2 * n_params
    return float(base + (2 * n_params * (n_params + 1)) / (n - n_params - 1))


def robust_fit(t: np.ndarray, y: np.ndarray, spec: ModelSpec) -> StintFit:
    """
    Fit *spec* to ``(t, y)`` with a robust loss.

    Uses ``scipy.optimize.least_squares`` with the ``soft_l1`` loss rather than ordinary
    least squares, so a single badly compromised lap that survived the MAD filter — traffic,
    a lock-up, a brief off — cannot drag the slope. This reproduces sklearn's
    ``HuberRegressor`` to within 0.01 s/lap on this data while keeping scikit-learn out of
    the backend's dependencies.

    On optimiser failure, falls back to a plain degree-appropriate ``polyfit`` and flags
    ``converged=False``, so one pathological stint never fails a whole session's response.
    """
    t = np.asarray(t, dtype=float)
    y = np.asarray(y, dtype=float)

    def residuals(p: np.ndarray) -> np.ndarray:
        return spec.func(t, *p) - y

    converged = True
    try:
        result = least_squares(
            residuals,
            x0=spec.initial_guess(t, y),
            loss=ROBUST_LOSS,
            f_scale=ROBUST_F_SCALE,
            max_nfev=MAX_FEV,
        )
        params = np.asarray(result.x, dtype=float)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("robust_fit failed for %s, falling back to polyfit: %s", spec.name, exc)
        converged = False
        degree = spec.n_params - 1
        coeffs = np.polyfit(t, y, degree)
        # polyfit returns highest-order first; our params are lowest-order first.
        params = np.asarray(coeffs[::-1], dtype=float)

    y_hat = spec.func(t, *params)
    rss = float(np.sum((y - y_hat) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    return StintFit(
        model=spec.name,
        params=params,
        param_names=spec.param_names,
        aicc=aicc(y, y_hat, spec.n_params),
        rss=rss,
        rmse=float(np.sqrt(rss / y.size)) if y.size else float("nan"),
        r2=float(1.0 - rss / ss_tot) if ss_tot > 0 else float("nan"),
        n_points=int(y.size),
        converged=converged,
    )


def select_model(
    t: np.ndarray,
    y: np.ndarray,
    model_names: Sequence[str] = ("linear", "quadratic"),
) -> tuple[StintFit, list[StintFit]]:
    """
    Fit every named model and return ``(best_by_aicc, all_fits)``.

    Ties and non-finite AICc values resolve toward the simpler model, because *all_fits* is
    evaluated in the order given and ``min`` keeps the first minimum.
    """
    specs = [MODELS[name] for name in model_names if name in MODELS]
    if not specs:
        raise ValueError(f"no known models among {list(model_names)}")

    fits = [robust_fit(t, y, spec) for spec in specs]
    best = min(fits, key=lambda f: f.aicc)
    return best, fits


# ── The degradation metric ─────────────────────────────────────────────

@dataclass(frozen=True)
class DegradationMetric:
    """Degradation expressed so that two stints can actually be compared."""

    s_per_lap: float
    window_lo: float
    window_hi: float
    #: ``"nominal"`` when the stint spanned NOMINAL_WINDOW, ``"observed"`` when the metric
    #: fell back to the stint's own tyre-life range. Never compare across sources.
    window_source: str
    s_per_lap_full_range: float
    full_range_lo: float
    full_range_hi: float
    comparable: bool
    #: Standard error of ``s_per_lap``, in seconds per lap.
    se_s_per_lap: float
    #: True when the estimate is at least SIGNIFICANCE_SIGMA standard errors from zero — that
    #: is, when this stint shows degradation distinguishable from a flat line at all.
    significant: bool


def _degradation_standard_error(
    fit: StintFit,
    t: np.ndarray,
    lo: float,
    hi: float,
) -> float:
    """
    Standard error of the windowed degradation estimate.

    The metric is a finite difference of a model that is linear in its parameters, so it is
    itself a linear combination of them, ``deg = c'beta`` with
    ``c = (x(hi) - x(lo)) / (hi - lo)``. Its variance is therefore ``c' Cov(beta) c`` with
    ``Cov(beta) = s^2 (X'X)^-1`` and ``s^2 = RSS / (n - k)``. No simulation needed.

    This is what separates a measured degradation rate from a number. Without it a six-lap
    stint whose lap times scatter by two seconds reports a confident-looking slope that is
    indistinguishable from noise, and anything that ranks stints by degradation puts those
    fits on top. Mildly approximate because the point fit minimises a robust loss rather
    than the squared error this covariance assumes; good enough to separate a real trend from
    a meaningless one, which is all it is used for.
    """
    spec = MODELS[fit.model]
    n, k = fit.n_points, spec.n_params
    if n <= k or hi <= lo:
        return float("nan")

    design = spec.design_matrix(t)
    try:
        xtx_inv = np.linalg.pinv(design.T @ design)
    except np.linalg.LinAlgError:  # pragma: no cover - defensive
        return float("nan")

    sigma_sq = fit.rss / (n - k)
    contrast = (spec.design_matrix(np.array([hi]))[0] - spec.design_matrix(np.array([lo]))[0])
    contrast = contrast / (hi - lo)
    variance = float(contrast @ (sigma_sq * xtx_inv) @ contrast)
    return float(np.sqrt(variance)) if variance > 0 else 0.0


def degradation_metric(
    fit: StintFit,
    tyre_life: np.ndarray,
    window: tuple[float, float] = NOMINAL_WINDOW,
) -> DegradationMetric:
    """
    Degradation in seconds per lap, measured as a finite difference of the fitted curve.

        deg = (predict(hi) - predict(lo)) / (hi - lo)

    **Why not just read the coefficient.** Because a coefficient means a different thing in
    each model family, and comparing them across families is meaningless: ``params[1]`` of a
    quadratic is the slope only at ``t=0``, while ``params[1]`` of a linear fit is the slope
    everywhere. ``analytics/tyres/tyre-performance-modeling.py:566-572`` indexes parameters
    positionally like this depending on which model won, and the consequences are
    measurable — on this database that approach yields degradation with a standard deviation
    of 0.19-0.48 s/lap and extremes beyond +/-2 s/lap, whereas the finite difference below
    yields 0.05-0.07 s/lap with a standard deviation of 0.06-0.08. The first set of numbers
    is not a noisier estimate of the same quantity; it is a different quantity per stint.

    **Why the window is always reported.** The nominal 5->15 window cannot be used for every
    stint: the median SOFT stint is 9 laps, so most soft stints never reach tyre life 15.
    Those fall back to their own observed range and are tagged ``window_source="observed"``.
    A number measured over laps 1-9 is not comparable with one measured over 5-15, so the
    window travels *with* the metric rather than being implied. Peer-group comparisons
    (z-scores, compound medians) must only pool stints sharing a window source.

    ``comparable`` requires two things: a tyre-life span long enough to measure over, **and**
    an estimate that is actually distinguishable from zero. Both guards are needed. Real
    stints exist whose lap times scatter by two seconds with a negative R-squared, and
    without the significance guard they report a confident degradation rate that is pure
    noise — and being noise, they are exactly the stints that rise to the top of any ranking
    sorted by degradation.
    """
    tyre_life = np.asarray(tyre_life, dtype=float)
    obs_lo = float(np.min(tyre_life))
    obs_hi = float(np.max(tyre_life))

    def slope(lo: float, hi: float) -> float:
        if hi <= lo:
            return float("nan")
        return float((fit.predict(hi) - fit.predict(lo)) / (hi - lo))

    full_range = slope(obs_lo, obs_hi)

    nominal_lo, nominal_hi = window
    if obs_lo <= nominal_lo and obs_hi >= nominal_hi:
        lo, hi, source = nominal_lo, nominal_hi, "nominal"
    else:
        lo, hi, source = obs_lo, obs_hi, "observed"

    value = slope(lo, hi)
    se = _degradation_standard_error(fit, tyre_life, lo, hi)
    significant = bool(
        np.isfinite(se) and np.isfinite(value) and abs(value) > SIGNIFICANCE_SIGMA * se
    )
    wide_enough = (hi - lo) >= MIN_WINDOW_SPAN if source == "observed" else True

    return DegradationMetric(
        s_per_lap=value,
        window_lo=lo,
        window_hi=hi,
        window_source=source,
        s_per_lap_full_range=full_range,
        full_range_lo=obs_lo,
        full_range_hi=obs_hi,
        comparable=bool(wide_enough and significant),
        se_s_per_lap=se,
        significant=significant,
    )


# ── Confidence band ────────────────────────────────────────────────────

@dataclass
class CurveBand:
    """Fitted curve on a grid, with optional bootstrap confidence band."""

    tyre_life: np.ndarray
    fit: np.ndarray
    lo: np.ndarray | None
    hi: np.ndarray | None


def bootstrap_band(
    t: np.ndarray,
    y: np.ndarray,
    fit: StintFit,
    n_points: int = BAND_POINTS,
    iterations: int = BOOTSTRAP_ITERATIONS,
    seed: int | None = 0,
) -> CurveBand:
    """
    Residual-bootstrap confidence band for a fitted stint curve.

    *Residuals* are resampled, not ``(x, y)`` pairs. Pair resampling duplicates x-values,
    which badly distorts a fit over the 8-25 distinct tyre-life values a stint provides;
    the rationale is documented at
    ``analytics/tyres/tyre-performance-modeling.py:490-492``.

    Two differences from that script. The refit uses the **same robust loss as the point
    fit**, so the band is consistent with the curve it surrounds — bootstrapping with plain
    least squares around a robust curve, as that script does, produces a band that is not
    the uncertainty of the line being drawn. And the generator is **seeded**, so the band
    does not shift between two requests for the same stint.
    """
    t = np.asarray(t, dtype=float)
    y = np.asarray(y, dtype=float)
    spec = MODELS[fit.model]
    grid = np.linspace(float(np.min(t)), float(np.max(t)), n_points)
    centre = spec.func(grid, *fit.params)

    fitted = fit.predict(t)
    residuals = y - fitted
    if residuals.size < 3 or iterations <= 0:
        return CurveBand(tyre_life=grid, fit=centre, lo=None, hi=None)

    rng = np.random.default_rng(seed)
    draws = np.empty((iterations, n_points), dtype=float)
    n_ok = 0
    for _ in range(iterations):
        resampled = fitted + rng.choice(residuals, size=residuals.size, replace=True)

        def residual_fn(p: np.ndarray, target: np.ndarray = resampled) -> np.ndarray:
            return spec.func(t, *p) - target

        try:
            result = least_squares(
                residual_fn,
                x0=fit.params,
                loss=ROBUST_LOSS,
                f_scale=ROBUST_F_SCALE,
                max_nfev=MAX_FEV,
            )
        except Exception:  # pragma: no cover - defensive
            continue
        draws[n_ok] = spec.func(grid, *result.x)
        n_ok += 1

    if n_ok < 3:
        return CurveBand(tyre_life=grid, fit=centre, lo=None, hi=None)

    draws = draws[:n_ok]
    return CurveBand(
        tyre_life=grid,
        fit=centre,
        lo=np.percentile(draws, BAND_LO_PCT, axis=0),
        hi=np.percentile(draws, BAND_HI_PCT, axis=0),
    )


# ── Cliff detection ────────────────────────────────────────────────────

def detect_cliff(
    fit: StintFit,
    tyre_life: np.ndarray,
    threshold: float = CLIFF_THRESHOLD,
    n_points: int = BAND_POINTS,
) -> float | None:
    """
    Tyre life at which the instantaneous degradation rate first exceeds *threshold*.

    A cliff is a *transition*, so two guards apply and both matter:

    1. Returns ``None`` for a linear fit, always. A linear model has a constant derivative,
       so thresholding it answers a different question — "is this stint's slope steep?" — and
       reports the answer as a lap number, which reads as a cliff at the very start.
       ``analytics/tyres/tyre-performance-modeling.py:532-542`` does exactly that, and the
       resulting "cliff at lap 0" is meaningless.
    2. Returns ``None`` when the rate is *already* above the threshold at the start of the
       observed range. There is no crossing to report: the stint was degrading hard from its
       first clean lap, which is a steep stint, not a cliff. Without this guard real stints
       report a cliff at tyre life 2, which is not a claim anyone should act on.

    Returns ``None`` when the rate never exceeds the threshold within the observed range.
    """
    if fit.model == "linear":
        return None

    grid = np.linspace(float(np.min(tyre_life)), float(np.max(tyre_life)), n_points)
    rate = np.gradient(fit.predict(grid), grid)

    if rate[0] > threshold:
        # Already past the threshold on the first lap: no transition was observed.
        return None

    above = rate > threshold
    if not above.any():
        return None
    return float(grid[int(np.argmax(above))])
