"""
F1 Pitwall — Tyre Degradation Constants

Single source of truth for every physical and statistical constant used by the tyre
degradation feature. Nothing else in the feature hardcodes one of these numbers.

This module is a dependency-free leaf: it imports nothing but the standard library, so
both ``backend.db.queries`` (for the clean-lap compound whitelist) and the pure-maths
modules in ``backend.ml`` can import it without pulling in DuckDB, FastAPI or pandas.

Each value carries its provenance. Where a number came from a local analytics script that
had it *wrong*, the docstring says so — several of these exist to stop a known bug being
reintroduced.
"""

from __future__ import annotations

from typing import Final

# ── Compounds ──────────────────────────────────────────────────────────

#: The modern dry compounds. Used as an *inclusive whitelist* in the clean-lap SQL
#: predicate — never as a blacklist. The ``laps`` table contains junk compound values
#: (the literal string ``'nan'``, SQL ``NULL``, and ``'UNKNOWN'``) because
#: ``backend/pipeline/ingest.py`` applies ``.astype(str)`` to the FastF1 column, which
#: stringifies NaN. A whitelist rejects all of those for free, and cannot miss a new junk
#: value that appears later; a blacklist would need updating every time. Do not
#: "simplify" this into a NOT IN clause.
CLEAN_COMPOUNDS: Final[tuple[str, ...]] = ("SOFT", "MEDIUM", "HARD")

#: Pre-2019 dry compounds, still present in the database for the 2018 season
#: (SUPERSOFT 5,549 laps / ULTRASOFT 4,323 / HYPERSOFT 887).
#:
#: These are permitted in Phase 1, where a per-stint fit is purely descriptive and makes
#: no cross-compound claim, and excluded from Phase 2, where they would be three extra
#: one-hot levels whose meaning is not comparable to the modern three. See POOLED_MIN_YEAR.
LEGACY_DRY_COMPOUNDS: Final[tuple[str, ...]] = ("SUPERSOFT", "ULTRASOFT", "HYPERSOFT")

#: Wet-weather compounds. Excluded from degradation modelling entirely: lap times on a
#: drying or wetting track are dominated by track evolution, not tyre wear, so a
#: degradation slope fitted through them measures the weather.
WET_COMPOUNDS: Final[tuple[str, ...]] = ("INTERMEDIATE", "WET")

ALL_DRY_COMPOUNDS: Final[tuple[str, ...]] = CLEAN_COMPOUNDS + LEGACY_DRY_COMPOUNDS

# ── Track status ───────────────────────────────────────────────────────

#: Track status meaning "all clear" (green). The clean-lap predicate matches this with
#: EXACT equality, never a substring test.
#:
#: FastF1's TrackStatus is a *concatenation* of single-digit codes for everything that
#: happened during the lap, so real values include '1', '12', '14', '124', '41' and '671'.
#: Substring matching is the correct way to *detect* a safety car (code '4') or VSC
#: ('6') — which frontend/src/panels/strategy-board/StrategyBoardPanel.tsx rightly does
#: with .includes('4') — but it is the wrong way to filter for *clean*, because '14' and
#: '124' both contain '1' while describing a lap that was not all-clear.
#:
#: Exact equality keeps 196,080 of 222,776 laps (88%).
TRACK_STATUS_ALL_CLEAR: Final[str] = "1"

#: Sanity bounds on lap time in seconds. A deliberately loose garbage guard only — the
#: shortest real F1 lap is ~60 s (Red Bull Ring) and a lap behind a safety car can exceed
#: 120 s. Genuine outlier rejection is the per-stint MAD filter's job, where it is local
#: to one stint and one compound. A global pace threshold (such as FastF1's 107%
#: pick_quicklaps) must NOT be used here: it deletes legitimate green laps run in traffic,
#: and those late-stint laps are exactly where the degradation signal lives.
LAP_TIME_MIN_S: Final[float] = 30.0
LAP_TIME_MAX_S: Final[float] = 300.0

# ── Fuel correction ────────────────────────────────────────────────────

#: Time gained per lap as fuel burns off, in seconds per lap.
#:
#: SIGN CONVENTION, and it matters: a car gets lighter as the race goes on, so raw lap
#: times fall for reasons that have nothing to do with tyres. To *remove* that effect the
#: correction must ADD time back in proportion to laps completed:
#:
#:     corrected = lap_time + FUEL_S_PER_LAP * lap_number
#:
#: The local script analytics/tyres/tyre-performance-modeling.py:318 subtracts instead,
#: which doubles the fuel effect rather than removing it, and it keys the correction on
#: StintLap, which resets at every pit stop — but fuel burns monotonically across the whole
#: race and does not reset. Both are bugs. Always correct against the ABSOLUTE lap number.
#:
#: The value: that script's default is 0.007 s/lap, roughly ten times too small (its own
#: comment states the real range is 0.06-0.08), making its correction a near no-op. The
#: accepted domain figure is 0.03-0.04 s/kg at roughly 1.6 kg/lap consumption. Fitting the
#: coefficient freely on 153,282 clean race laps in this database recovers -0.0502 s/lap,
#: which corroborates the domain range. 0.055 is used as the Phase 1 constant; Phase 2
#: does not use it at all, because it learns the coefficient from the data.
FUEL_S_PER_LAP: Final[float] = 0.055

#: How far a session's field pace trend may sit from FUEL_S_PER_LAP before the response
#: carries a warning, in seconds per lap.
#:
#: The fuel constant is well calibrated on a typical race: across 58 races in this database
#: the median field trend is -0.0566 s/lap against the 0.055 assumed here, and removing the
#: measured trend instead of the constant shifts per-compound median degradation by under
#: 0.003 s/lap. That three-way agreement — assumed constant, observed field trend, and the
#: -0.0502 the pooled model fits freely — is why no separate track-evolution correction
#: exists.
#:
#: Individual sessions still deviate: Madrid 2026, a new circuit rubbering in, runs
#: -0.0817 s/lap, and absolute degradation there is biased low by the difference. Warning is
#: preferred over silently subtracting the measured trend, because that trend also contains
#: the field's own average tyre degradation, so removing it wholesale would delete part of
#: the signal being measured.
FIELD_TREND_WARN_S: Final[float] = 0.02

# ── Robust fitting ─────────────────────────────────────────────────────

#: Laps further than this many MADs from their stint's median lap time are dropped before
#: fitting. 4x is deliberately conservative; 3x is stricter. From
#: analytics/tyres/tyre-performance-modeling.py:77.
#:
#: Kept loose on purpose: a tight prefilter combined with the soft_l1 loss below
#: double-counts outlier rejection and can delete the genuinely slow end-of-stint laps that
#: are the signal being measured.
MAD_THRESHOLD: Final[float] = 4.0

#: Scale substituted when a stint's MAD is exactly zero, in seconds.
#:
#: A zero MAD means at least half the lap times equal the median, so the only values with
#: any spread are the outliers. The script this ports falls back to the standard deviation
#: in that case, which lets the outliers set their own acceptance threshold — for ten laps
#: at 90.0 s plus one at 120.0 s, std is 8.62, the threshold becomes 34.5 s, and the
#: outlier survives. A fixed floor avoids that: 4 x 0.5 = 2.0 s rejects it, while a
#: genuinely uniform stint keeps every lap because all its deviations are zero.
#:
#: 0.5 s is roughly the spread of a clean stint's lap times, so it is a plausible scale to
#: assume when the robust estimator cannot provide one.
MAD_ZERO_FLOOR_S: Final[float] = 0.5

#: scipy.optimize.least_squares loss and scale for the robust stint fit.
#:
#: soft_l1 reproduces sklearn's HuberRegressor to within 0.01 s/lap on this data with a
#: tighter spread, which keeps scikit-learn out of the backend's declared dependencies.
#: f_scale is in seconds: residuals much larger than ~0.3 s are treated as outliers, which
#: is the right order of magnitude for lap-time noise within a single stint.
ROBUST_LOSS: Final[str] = "soft_l1"
ROBUST_F_SCALE: Final[float] = 0.3

#: Maximum function evaluations for a single fit.
MAX_FEV: Final[int] = 20_000

# ── Stint eligibility ──────────────────────────────────────────────────

#: Minimum clean laps before a stint is fitted at all. Below ~5 points a two-parameter fit
#: is barely identified and a three-parameter one is not. Of 9,858 stints in this database,
#: 8,285 clear 5 laps and 7,568 clear 8.
MIN_CLEAN_LAPS: Final[int] = 5

#: Minimum clean laps to enter the Phase 2 training set — stricter than Phase 1, because a
#: pooled fit can afford to be selective.
POOLED_MIN_CLEAN_LAPS: Final[int] = 8

# ── Degradation metric ─────────────────────────────────────────────────

#: Tyre-life window over which degradation is reported, in seconds per lap:
#:
#:     deg = (predicted(hi) - predicted(lo)) / (hi - lo)
#:
#: This is a MODEL-AGNOSTIC metric and using it is not optional. Reading a coefficient
#: straight out of the fitted parameters is incomparable across model families — params[1]
#: of a quadratic is not params[1] of a linear fit, and
#: analytics/tyres/tyre-performance-modeling.py:566-572 makes exactly that mistake. On
#: this database, extracting raw coefficients yields degradation with a standard deviation
#: of 0.19-0.48 s/lap and absurd extremes beyond +/-2 s/lap; the windowed metric yields a
#: physically plausible 0.05-0.07 s/lap with a standard deviation of 0.06-0.08.
#:
#: 5->15 is the nominal window. A stint that does not span it (the median SOFT stint is
#: only 9 laps) falls back to its own observed tyre-life range, and the result is tagged
#: so that nothing downstream compares an observed-window number with a nominal one.
NOMINAL_WINDOW: Final[tuple[float, float]] = (5.0, 15.0)

#: Minimum tyre-life span a stint must cover for its windowed metric to mean anything.
MIN_WINDOW_SPAN: Final[float] = 4.0

#: How many standard errors a degradation estimate must sit from zero to count as real.
#:
#: Without this guard the pipeline reports confident-looking rates for stints that carry no
#: trend at all. A real example from Madrid 2026: a ten-lap stint with lap times scattered
#: between 102 and 108 s, an R-squared of -0.18 and an RMSE of 2.1 s still yields
#: "+0.178 s/lap". Being noise rather than signal, such fits produce extreme values, so they
#: dominate any ranking sorted by degradation — the one view most likely to be built on this
#: number.
#:
#: 2.0 is the conventional two-sigma bar, roughly 95% confidence. Stints that fail it are
#: still returned, with ``significant: false``, so a flat stint reads as "no measurable
#: degradation" rather than vanishing.
SIGNIFICANCE_SIGMA: Final[float] = 2.0

# ── Reporting ──────────────────────────────────────────────────────────

#: Instantaneous degradation rate, in s/lap, above which a tyre is deemed to have fallen
#: off a cliff. From analytics/tyres/tyre-performance-modeling.py:98.
#:
#: Only meaningful for a curved (quadratic) fit: a linear fit has a constant derivative, so
#: thresholding it reports "the cliff is at lap 0" whenever the slope is steep, which is
#: what that script does at lines 532-542. detect_cliff() returns None for linear fits.
CLIFF_THRESHOLD: Final[float] = 0.15

#: |z| above which a stint's degradation is flagged anomalous against its peers. From
#: analytics/tyres/tyre-performance-modeling.py:598.
ANOMALY_Z_THRESHOLD: Final[float] = 1.5

#: Residual-bootstrap iterations for the confidence band, and the number of points on the
#: returned curve grid.
#:
#: Residuals are resampled rather than (x, y) pairs: pair resampling duplicates x-values,
#: which distorts a fit over the ~10-25 distinct tyre-life values a stint provides. The
#: rationale is documented at analytics/tyres/tyre-performance-modeling.py:490-492. Unlike
#: that script, the bootstrap refit uses the SAME loss as the point fit, so the band is
#: consistent with the curve it surrounds.
BOOTSTRAP_ITERATIONS: Final[int] = 200
BAND_POINTS: Final[int] = 40

#: Confidence band percentiles.
BAND_LO_PCT: Final[float] = 2.5
BAND_HI_PCT: Final[float] = 97.5

# ── Phase 2: pooled model ──────────────────────────────────────────────

#: Earliest season in the pooled training set. 2018 is excluded because its compounds were
#: SUPERSOFT/ULTRASOFT/HYPERSOFT (see LEGACY_DRY_COMPOUNDS); including the year while
#: excluding its compounds would leave almost no usable rows and an artifact labelled
#: "2018-2026" that misrepresents what it learned.
POOLED_MIN_YEAR: Final[int] = 2019

#: Session types used for pooled training. Races only: practice and qualifying stints are
#: short, run on low fuel and driven to a different brief, so their degradation is not
#: comparable to a race stint.
POOLED_SESSION_TYPES: Final[tuple[str, ...]] = ("R",)

#: Cross-validation folds. Folds are formed by holding out WHOLE RACES, never random laps
#: — laps within a race are heavily correlated, so a random split leaks the answer across
#: the split and reports an accuracy the model does not have.
POOLED_CV_FOLDS: Final[int] = 5
POOLED_CV_SEED: Final[int] = 0

#: Clip bound on the pooled target (lap time minus the session median, in seconds). Laps
#: beyond this are incidents, traffic jams or safety-car crawls that survived the clean
#: filter, and they dominate a least-squares fit if left in.
POOLED_TARGET_CLIP_S: Final[float] = 8.0

#: Artifact filenames under config.MODELS_DIR.
POOLED_MODEL_VERSION: Final[str] = "v1"
POOLED_ARTIFACT_NAME: Final[str] = "tyre_pooled_v1"

#: Caveats shipped inside the artifact and echoed by the API, so the limitation travels
#: with the numbers instead of living only in a docstring.
POOLED_CAVEATS: Final[tuple[str, ...]] = (
    "Coefficients are not causally interpretable: tyre_life and lap_number are collinear "
    "within a stint, so the fitted fuel and wear terms are not cleanly separable.",
    "Stints are right-censored by the pit decision — teams pit before the cliff — so "
    "observed degradation understates true degradation, and the bias differs by compound. "
    "A pooled fit of stint slope on compound shows no compound ordering for this reason "
    "(R^2 = 0.095, SOFT - HARD = -0.006 s/lap within circuit).",
    "Track temperature is not corrected for: the pipeline does not ingest weather data.",
    "Use this model for out-of-sample prediction, per-stint residuals and the circuit "
    "severity ranking — not for causal claims about compounds.",
)
