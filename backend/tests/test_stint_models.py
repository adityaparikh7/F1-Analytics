"""
Tests for the pure stint-fitting maths.

Two tests here are regression tests for specific bugs in
``analytics/tyres/tyre-performance-modeling.py`` and are the reason this module exists:
:func:`test_degradation_metric_is_model_agnostic` and
:func:`test_robust_fit_resists_outliers_where_polyfit_does_not`. If either is ever relaxed,
the corresponding bug is back.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy.stats import median_abs_deviation

from backend.ml.constants import MIN_WINDOW_SPAN
from backend.ml.stint_models import (
    MODELS,
    aicc,
    bootstrap_band,
    degradation_metric,
    detect_cliff,
    mad_outlier_mask,
    robust_fit,
    select_model,
)
from backend.tests.fixtures.synthetic import make_stint

# ── Robust fitting (F3) ────────────────────────────────────────────────

def test_robust_fit_recovers_known_slope():
    stint = make_stint(n_laps=20, l0=90.0, deg=0.06, noise=0.1, seed=1)
    fit = robust_fit(stint.tyre_life.values, stint.lap_time.values, MODELS["linear"])

    assert fit.converged
    assert fit.params[1] == pytest.approx(0.06, abs=0.01)
    assert fit.r2 > 0.5


def test_robust_fit_resists_outliers_where_polyfit_does_not():
    """
    The soft_l1 loss must survive outliers that ordinary least squares cannot.

    This is the test that fails the moment someone swaps the robust loss for a plain fit, so
    it asserts both halves: that the robust slope is still right, *and* that a naive fit on
    the identical data is materially wrong. Without the second assertion the test would
    still pass against a non-robust implementation whenever the outliers happened to be
    benign.
    """
    true_deg = 0.06
    stint = make_stint(
        n_laps=20, l0=90.0, deg=true_deg, noise=0.1,
        outliers=((3, 5.0), (11, 5.0)), seed=2,
    )
    t = stint.tyre_life.values.astype(float)
    y = stint.lap_time.values

    robust_slope = robust_fit(t, y, MODELS["linear"]).params[1]
    naive_slope = np.polyfit(t, y, 1)[0]

    assert robust_slope == pytest.approx(true_deg, abs=0.01)
    assert abs(naive_slope - true_deg) > 0.03, (
        "ordinary least squares should be visibly dragged by the injected outliers; "
        "if it is not, this test no longer proves the robust loss is doing anything"
    )


# ── Degradation metric (F1) ────────────────────────────────────────────

def test_degradation_metric_is_model_agnostic():
    """
    The reported degradation must not depend on which model family won.

    Fitting the same stint as linear and as quadratic produces parameter vectors of
    different length whose entries mean different things. Reading a coefficient positionally
    — which analytics/tyres/tyre-performance-modeling.py:566-572 does — therefore yields two
    incomparable numbers. The windowed finite difference must agree.
    """
    stint = make_stint(n_laps=25, l0=90.0, deg=0.06, noise=0.05, seed=3)
    t = stint.tyre_life.values.astype(float)
    y = stint.lap_time.values

    linear = robust_fit(t, y, MODELS["linear"])
    quadratic = robust_fit(t, y, MODELS["quadratic"])

    # The parameter vectors are genuinely not comparable...
    assert len(linear.params) != len(quadratic.params)

    # ...but the metric is.
    deg_linear = degradation_metric(linear, t)
    deg_quadratic = degradation_metric(quadratic, t)
    assert deg_linear.s_per_lap == pytest.approx(deg_quadratic.s_per_lap, abs=0.005)
    assert deg_linear.window_source == deg_quadratic.window_source == "nominal"


def test_degradation_metric_falls_back_to_observed_window_for_short_stint():
    """A 9-lap soft stint cannot span the nominal 5->15 window, and must say so."""
    stint = make_stint(n_laps=9, tyre_life_start=1, deg=0.08, noise=0.05, seed=4)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])

    metric = degradation_metric(fit, t)
    assert metric.window_source == "observed"
    assert (metric.window_lo, metric.window_hi) == (1.0, 9.0)
    # Span of 8 clears MIN_WINDOW_SPAN, and a clean 0.08 s/lap trend is clearly significant.
    assert metric.comparable is True
    assert metric.significant is True


# ── Degradation uncertainty ────────────────────────────────────────────

def test_degradation_standard_error_shrinks_with_cleaner_data():
    """A tighter stint must yield a smaller standard error on the same true slope."""
    noisy = make_stint(n_laps=15, deg=0.06, noise=0.8, seed=20)
    clean = make_stint(n_laps=15, deg=0.06, noise=0.02, seed=20)

    se_noisy = degradation_metric(
        robust_fit(noisy.tyre_life.values, noisy.lap_time.values, MODELS["linear"]),
        noisy.tyre_life.values.astype(float),
    ).se_s_per_lap
    se_clean = degradation_metric(
        robust_fit(clean.tyre_life.values, clean.lap_time.values, MODELS["linear"]),
        clean.tyre_life.values.astype(float),
    ).se_s_per_lap

    assert se_clean < se_noisy


def test_scattered_stint_is_flagged_insignificant_and_incomparable():
    """
    A stint carrying no trend must not report a confident degradation rate.

    Modelled on a real Madrid 2026 stint: ten laps scattered across six seconds, R-squared
    negative. Before the significance guard this reported "+0.178 s/lap" as comparable, and
    because noisy fits produce extreme slopes it sorted to the very top of a ranking by
    degradation — the worst possible place for a meaningless number.
    """
    stint = make_stint(n_laps=10, deg=0.0, noise=2.0, seed=21)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])

    metric = degradation_metric(fit, t)
    assert metric.significant is False
    assert metric.comparable is False
    assert metric.se_s_per_lap > abs(metric.s_per_lap) / 2


def test_strong_clean_trend_is_significant():
    stint = make_stint(n_laps=20, deg=0.08, noise=0.05, seed=22)
    t = stint.tyre_life.values.astype(float)
    metric = degradation_metric(
        robust_fit(t, stint.lap_time.values, MODELS["linear"]), t
    )
    assert metric.significant is True
    assert metric.se_s_per_lap < 0.02


def test_design_matrix_shape_matches_parameter_count():
    """
    The standard error is exact only because both models are linear in their parameters.
    This pins that property: a model whose design matrix stops matching its parameter count
    would silently invalidate the uncertainty calculation.
    """
    t = np.arange(1.0, 11.0)
    for spec in MODELS.values():
        assert spec.design_matrix(t).shape == (10, spec.n_params)


def test_degradation_metric_flags_incomparable_when_span_too_short():
    stint = make_stint(n_laps=3, tyre_life_start=1, deg=0.08, noise=0.01, seed=5)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])

    metric = degradation_metric(fit, t)
    assert metric.window_source == "observed"
    assert metric.window_hi - metric.window_lo < MIN_WINDOW_SPAN
    assert metric.comparable is False


def test_degradation_metric_window_is_always_reported():
    """Every metric carries its window, so nothing downstream can compare blindly."""
    stint = make_stint(n_laps=20, deg=0.05, seed=6)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])
    metric = degradation_metric(fit, t)

    assert metric.window_lo is not None
    assert metric.window_hi is not None
    assert metric.window_source in {"nominal", "observed"}
    assert np.isfinite(metric.s_per_lap_full_range)


# ── AICc ───────────────────────────────────────────────────────────────

def test_aicc_is_infinite_when_undefined():
    y = np.array([1.0, 2.0, 3.0])
    assert aicc(y, y, n_params=2) == float("inf")                 # perfect fit, rss == 0
    assert aicc(y[:2], np.array([1.1, 2.1]), n_params=2) == float("inf")  # n - k - 1 <= 0


def test_aicc_usually_prefers_the_simpler_model_on_linear_data():
    """
    AICc must penalise the unneeded third parameter on genuinely linear data.

    Asserted across many noise draws rather than one, because the claim is statistical: a
    single realisation can legitimately favour the quadratic when the two are near-tied
    (seed 7 gives AICc -109.6 linear vs -110.4 quadratic — a 0.8-unit gap). Pinning one seed
    would make this test a fragile record of which draw happened to win, and the real-data
    split is 260 linear to 202 quadratic, so a comfortable majority is the honest bar.
    """
    wins = {"linear": 0, "quadratic": 0}
    for seed in range(60):
        stint = make_stint(n_laps=20, deg=0.06, curvature=0.0, noise=0.08, seed=seed)
        best, fits = select_model(stint.tyre_life.values, stint.lap_time.values)
        wins[best.model] += 1
        assert {f.model for f in fits} == {"linear", "quadratic"}

    assert wins["linear"] > wins["quadratic"] * 2, (
        f"AICc should clearly favour linear on linear data, got {wins}"
    )


def test_aicc_penalty_grows_with_parameter_count():
    """The small-sample correction must make the extra parameter genuinely costly."""
    y = np.linspace(90.0, 91.0, 20)
    y_hat = y + 0.05
    assert aicc(y, y_hat, n_params=3) > aicc(y, y_hat, n_params=2)


def test_aicc_prefers_quadratic_on_strongly_curved_data():
    stint = make_stint(n_laps=25, deg=0.0, curvature=0.02, noise=0.05, seed=8)
    best, _ = select_model(stint.tyre_life.values, stint.lap_time.values)
    assert best.model == "quadratic"


# ── MAD outlier mask ───────────────────────────────────────────────────

def test_mad_mask_keeps_everything_when_all_values_identical():
    """The mad == 0 fallback chain must not reject every lap."""
    y = np.full(10, 90.0)
    assert mad_outlier_mask(y).all()


def test_mad_mask_rejects_a_clear_outlier_despite_zero_mad():
    """
    An outlier must not be able to set its own acceptance threshold.

    Ten laps at 90.0 s plus one at 120.0 s gives a MAD of exactly zero, because over half
    the values equal the median. The prior art falls back to the standard deviation there —
    but the only thing contributing spread is the outlier itself, so std is 8.62, the
    threshold becomes 4 x 8.62 = 34.5 s, and the 30 s outlier survives. The fixed floor
    rejects it. This test is why that `std` rung was dropped.
    """
    y = np.concatenate([np.full(10, 90.0), [120.0]])
    assert median_abs_deviation(y, scale="normal") == 0.0, "fixture must produce a zero MAD"
    assert 4.0 * np.std(y) > 30.0, "a std fallback would wrongly keep this outlier"

    mask = mad_outlier_mask(y)
    assert mask[:10].all()
    assert not mask[10]


def test_mad_mask_handles_empty_input():
    assert mad_outlier_mask(np.array([])).shape == (0,)


# ── Cliff detection ────────────────────────────────────────────────────

def test_detect_cliff_returns_none_for_linear_at_any_slope():
    """
    A linear fit has no cliff, however steep it is.

    The prior art thresholds the constant derivative and reports lap 0, which reads as "the
    tyre fell off a cliff immediately" for any merely-fast-degrading stint.
    """
    stint = make_stint(n_laps=20, deg=0.9, noise=0.05, seed=9)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])
    assert detect_cliff(fit, t) is None


def test_detect_cliff_finds_a_lap_for_a_curved_stint():
    stint = make_stint(n_laps=25, deg=0.0, curvature=0.03, noise=0.02, seed=10)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["quadratic"])
    cliff = detect_cliff(fit, t)
    assert cliff is not None
    assert t.min() <= cliff <= t.max()


# ── Bootstrap band ─────────────────────────────────────────────────────

def test_bootstrap_band_brackets_the_fit_and_is_deterministic():
    stint = make_stint(n_laps=20, deg=0.06, noise=0.12, seed=11)
    t = stint.tyre_life.values.astype(float)
    y = stint.lap_time.values
    fit = robust_fit(t, y, MODELS["linear"])

    band = bootstrap_band(t, y, fit, iterations=60, seed=0)
    assert band.lo is not None and band.hi is not None
    assert np.all(band.lo <= band.fit + 1e-6)
    assert np.all(band.hi >= band.fit - 1e-6)

    # Seeded: the same request twice must not move the band.
    again = bootstrap_band(t, y, fit, iterations=60, seed=0)
    np.testing.assert_allclose(band.lo, again.lo)
    np.testing.assert_allclose(band.hi, again.hi)


def test_bootstrap_band_degrades_to_no_band_when_disabled():
    stint = make_stint(n_laps=12, seed=12)
    t = stint.tyre_life.values.astype(float)
    fit = robust_fit(t, stint.lap_time.values, MODELS["linear"])

    band = bootstrap_band(t, stint.lap_time.values, fit, iterations=0)
    assert band.lo is None and band.hi is None
    assert band.fit.shape == band.tyre_life.shape
