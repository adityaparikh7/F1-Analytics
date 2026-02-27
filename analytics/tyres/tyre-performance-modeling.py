"""
Tyre performance modelling (improved)
- physical warm-up + exponential degradation model
- compound-specific fits
- filters for out-laps / in-laps / safety car laps
- sector-level modelling when sector times available
- fuel / track-temp corrections (if available)
- degradation rate (derivative) visualization
- bootstrap confidence bands for fitted curves
- interactive Plotly outputs
"""

import numpy as np
import pandas as pd
import fastf1
import fastf1.plotting
import matplotlib.pyplot as plt
import seaborn as sns
import plotly.express as px
import plotly.graph_objects as go
import plotly.io as pio
from scipy.optimize import curve_fit
from scipy.stats import median_abs_deviation
from typing import Tuple, Dict

pio.renderers.default = "browser"

# Configure FastF1
fastf1.Cache.enable_cache("analytics/cache")
fastf1.plotting.setup_mpl(mpl_timedelta_support=True, color_scheme="fastf1")

# ---------- CONFIG ----------
YEAR = 2025
RACE = "Qatar"
EVENT = "R"           # R/Q/F
DRIVER = "1"         # number OR 3-letter code
MIN_POINTS_FOR_FIT = 4
BOOTSTRAP_ITER = 300
# ---------------------------

# --- LOAD SESSION ---
session = fastf1.get_session(YEAR, RACE, EVENT)
session.load()
compound_map = fastf1.plotting.get_compound_mapping(session)

# --- UTIL: tyre model definitions ---


def warmup_model(laps, Lcold, d, w):
    """Warm-up behaviour (fast exponential approach) - applied to first few laps."""
    return Lcold - d * np.exp(-w * laps)


def tyre_model(laps, L0, a, b, c):
    """
    Combined model:
    L0 + a*(1 - exp(-b*t))  + c*t
    - a*(1-exp(-b*t)) captures fast non-linear warm-up/early phase
    - c*t models linear long-term degradation (wear)
    """
    return L0 + a * (1 - np.exp(-b * laps)) + c * laps

# Safe fitter wrapper


def fit_tyremodel(x, y, p0=None, bounds=None, model=tyre_model, maxfev=10000):
    try:
        popt, pcov = curve_fit(
            model, x, y, p0=p0, bounds=bounds or (-np.inf, np.inf), maxfev=maxfev)
        return popt, pcov
    except Exception as e:
        # fallback to a simple linear fit
        coefs = np.polyfit(x, y, 1)
        # best-effort guess
        popt = np.array([np.mean(y), 0.0, 0.001, coefs[0]])
        return popt, None

# --- PREPROCESS LAPS ---


def preprocess_laps(session: fastf1.core.Session, driver: str) -> pd.DataFrame:
    laps = session.laps.pick_drivers(driver).copy()

    # Keep only laps with LapTime
    laps = laps.dropna(subset=["LapTime"]).reset_index(drop=True)

    # Convert LapTime to seconds
    if pd.api.types.is_timedelta64_dtype(laps["LapTime"]):
        laps["LapTime (s)"] = laps["LapTime"].dt.total_seconds()
    else:
        laps["LapTime (s)"] = laps["LapTime"].astype(float)

    # LapNumber and Stint
    if "LapNumber" not in laps.columns:
        laps["LapNumber"] = np.arange(1, len(laps) + 1)
    if "Stint" not in laps.columns:
        laps["Stint"] = laps["Stint"].fillna(1).astype(int)

    # Stint-relative lap number
    laps["StintStart"] = laps.groupby("Stint")["LapNumber"].transform("min")
    laps["StintLap"] = laps["LapNumber"] - laps["StintStart"] + 1

    # Identify pit in/out laps conservatively (FastF1 may have these flags)
    # laps["IsOutLap"] = laps.get("PitOutLap", False).astype(bool)
    # laps["IsInLap"] = laps.get("PitInLap", False).astype(bool)

    # Safe "IsOutLap" / "IsInLap" creation
    if "PitOutLap" in laps.columns:
        laps["IsOutLap"] = laps["PitOutLap"].astype(bool)
    else:
        laps["IsOutLap"] = pd.Series(False, index=laps.index)

    if "PitInLap" in laps.columns:
        laps["IsInLap"] = laps["PitInLap"].astype(bool)
    else:
        laps["IsInLap"] = pd.Series(False, index=laps.index)

    # Track status / Safety car
    # fastf1 sometimes includes 'IsSafetyCar'
    laps["IsSC"] = False
    if "SafetyCar" in laps.columns:
        laps["IsSC"] = laps["SafetyCar"].astype(bool)
    # fallback: if TrackStatus exists and != 1 then not green
    if "TrackStatus" in laps.columns:
        laps["IsSC"] = laps["IsSC"] | (laps["TrackStatus"].astype(str) != "1")

    # Sector times in seconds if available
    for s in [1, 2, 3]:
        col = f"Sector{s}Time"
        if col in laps.columns:
            if pd.api.types.is_timedelta64_dtype(laps[col]):
                laps[f"S{s} (s)"] = laps[col].dt.total_seconds()
            else:
                laps[f"S{s} (s)"] = pd.to_numeric(laps[col], errors="coerce")

    # Rolling smoothing per compound for visualization only
    laps["Rolling"] = laps.groupby("Compound")["LapTime (s)"].transform(
        lambda x: x.rolling(3, min_periods=1).mean())

    return laps


laps = preprocess_laps(session, DRIVER)

# --- FILTERS: remove outlaps, inlaps, safety car and obvious outliers ---


def filter_laps(laps: pd.DataFrame) -> pd.DataFrame:
    safe = laps[~laps["IsOutLap"] & ~laps["IsInLap"] & ~laps["IsSC"]].copy()
    # Remove extreme outliers ( > 3 MAD from median per compound)

    def filter_comp(group):
        med = group["LapTime (s)"].median()
        mad = median_abs_deviation(group["LapTime (s)"].values, scale='normal')
        # if mad is 0 (rare), use std
        if mad == 0:
            mad = group["LapTime (s)"].std() or 0.5
        mask = (np.abs(group["LapTime (s)"] - med) < 4 * mad)
        return group.loc[mask]
    safe = safe.groupby("Compound", group_keys=False).apply(
        filter_comp).reset_index(drop=True)
    return safe


laps_clean = filter_laps(laps)
if laps_clean.empty:
    raise RuntimeError(
        "No laps left after filtering — check data or relax filters.")

# --- TRACK / ENVIRONMENT CORRECTIONS (optional columns) ---


def apply_environment_corrections(laps: pd.DataFrame) -> pd.DataFrame:
    L = laps.copy()
    # Fuel effect approximation: assume each lap heavier fuel adds ~0.03-0.04s (user tweakable)
    if "Fuel" in L.columns:
        # If explicit fuel weight data available
        L["FuelCorr"] = L["LapTime (s)"] - 0.035 * L["Fuel"]
    else:
        # Heuristic: later laps lighter -> subtract small linear factor per lap number
        L["FuelCorr"] = L["LapTime (s)"] - 0.007 * \
            (L["LapNumber"] - L["LapNumber"].min())

    # Track temp correction (if TrackTemp present)
    if "TrackTemp" in L.columns:
        mean_temp = L["TrackTemp"].mean()
        L["EnvCorr"] = L["FuelCorr"] - 0.01 * (L["TrackTemp"] - mean_temp)
    else:
        L["EnvCorr"] = L["FuelCorr"]

    return L


laps_corr = apply_environment_corrections(laps_clean)

# --- FITTING: compound + stint specific ---
fit_results: Dict[Tuple[str, int], dict] = {}
for (compound, stint), group in laps_corr.groupby(["Compound", "Stint"]):
    # only use stints with enough good laps
    if len(group) < MIN_POINTS_FOR_FIT:
        continue

    x = group["StintLap"].values
    y = group["EnvCorr"].values

    # initial guesses and bounds (reasonable physical ranges)
    p0 = [np.median(y), 1.0, 0.5, 0.01]         # L0, a, b, c
    bounds = ([-5, 0, 1e-6, -0.5], [200, 10, 5.0, 1.0])

    popt, pcov = fit_tyremodel(x, y, p0=p0, bounds=bounds, model=tyre_model)
    fit_results[(compound, stint)] = {
        "params": popt,
        "cov": pcov,
        "x": x,
        "y": y,
        "laps_df": group
    }

# If nothing fit, fall back to compound-level (aggregate over stints)
if not fit_results:
    for compound, group in laps_corr.groupby("Compound"):
        if len(group) < MIN_POINTS_FOR_FIT:
            continue
        x = group["StintLap"].values
        y = group["EnvCorr"].values
        p0 = [np.median(y), 1.0, 0.5, 0.01]
        bounds = ([-5, 0, 1e-6, -0.5], [200, 10, 5.0, 1.0])
        popt, pcov = fit_tyremodel(
            x, y, p0=p0, bounds=bounds, model=tyre_model)
        fit_results[(compound, 0)] = {
            "params": popt, "cov": pcov, "x": x, "y": y, "laps_df": group}

# --- BOOTSTRAP CONFIDENCE BANDS for fitted curves ---
bootstrap_bands = {}
for key, res in fit_results.items():
    compound, stint = key
    x_obs = res["x"]
    y_obs = res["y"]
    x_fit = np.linspace(x_obs.min(), x_obs.max(), 200)
    preds = []
    for _ in range(BOOTSTRAP_ITER):
        idx = np.random.choice(np.arange(len(x_obs)),
                               size=len(x_obs), replace=True)
        x_s = x_obs[idx]
        y_s = y_obs[idx]
        try:
            popt, _ = curve_fit(tyre_model, x_s, y_s,
                                p0=res["params"], maxfev=10000)
            preds.append(tyre_model(x_fit, *popt))
        except Exception:
            preds.append(tyre_model(x_fit, *res["params"]))  # fallback
    preds = np.vstack(preds)  # shape (B, len(x_fit))
    lo = np.percentile(preds, 2.5, axis=0)
    hi = np.percentile(preds, 97.5, axis=0)
    median = np.percentile(preds, 50, axis=0)
    bootstrap_bands[key] = {"x_fit": x_fit,
                            "median": median, "lo": lo, "hi": hi}

# --- DERIVATIVES: degradation rate (numerical derivative of fitted median) ---
deg_rates = {}
for key, band in bootstrap_bands.items():
    x = band["x_fit"]
    y = band["median"]
    # numerical derivative
    dy = np.gradient(y, x)
    deg_rates[key] = {"x": x, "deg": dy}

# --- PLOTTING: Matplotlib static (per compound & stint) ---
sns.set_style("whitegrid")
for key, res in fit_results.items():
    compound, stint = key
    df = res["laps_df"]
    x_obs = res["x"]
    y_obs = res["y"]
    band = bootstrap_bands[key]
    params = res["params"]

    fig, ax = plt.subplots(figsize=(10, 6))
    color = compound_map.get(compound.upper(), "#666666")
    # scatter of observations
    ax.scatter(
        x_obs, y_obs, label=f"Observations ({len(x_obs)})", color=color, alpha=0.6, s=50, edgecolor='k')
    # fitted median
    ax.plot(band["x_fit"], band["median"],
            label="Model median", linewidth=3, color=color)
    # confidence band
    ax.fill_between(band["x_fit"], band["lo"], band["hi"],
                    color=color, alpha=0.2, label="95% CI")
    # plot derivative on twin axis
    ax2 = ax.twinx()
    deg = deg_rates[key]["deg"]
    ax2.plot(band["x_fit"], deg, linestyle="--",
             label="Deg rate (s/lap)", color='tab:red')
    ax2.set_ylabel("Degradation (s / lap)", color='tab:red')
    ax.set_xlabel("Lap in Stint")
    ax.set_ylabel("Lap Time (s) (env corrected)")
    ax.set_title(f"Compound: {compound} — Stint: {stint} — Driver {DRIVER}")
    ax.invert_yaxis()  # lower is faster, so invert
    ax.legend(loc="upper left")
    ax2.legend(loc="upper right")
    plt.tight_layout()
    plt.show()

# --- SECTOR-LEVEL SUMMARY (if sectors present) ---
sector_cols = [c for c in laps_corr.columns if c.startswith(
    "S") and c.endswith("(s)")]
if sector_cols:
    # plot average sector times by compound
    avg_sector = laps_corr.groupby(
        "Compound")[sector_cols].mean().reset_index()
    print("\nAverage sector times by compound:")
    print(avg_sector.to_markdown(index=False))

# --- INTERACTIVE: Plotly overview of lap times and fitted curves across stints ---
fig = go.Figure()
compound_order = sorted(set([k[0] for k in fit_results.keys()]))
for key, res in fit_results.items():
    compound, stint = key
    df = res["laps_df"]
    colname = f"{compound} - stint {stint}"
    color = compound_map.get(compound.upper(), None)
    # scatter raw points
    fig.add_trace(go.Scatter(
        x=df["StintLap"],
        y=df["LapTime (s)"],
        mode="markers",
        marker=dict(size=7, opacity=0.6),
        name=f"{colname} obs",
        hovertext=df.apply(
            lambda r: f"Lap {int(r.LapNumber)} — {r['LapTime (s)']:.3f}s", axis=1)
    ))
    # fitted median and CI
    band = bootstrap_bands[key]
    fig.add_trace(go.Scatter(x=band["x_fit"], y=band["median"],
                  mode="lines", name=f"{colname} fit", line=dict(width=3)))
    fig.add_trace(go.Scatter(x=band["x_fit"], y=band["hi"], mode="lines",
                  name=f"{colname} hi", line=dict(width=0), showlegend=False))
    fig.add_trace(go.Scatter(x=band["x_fit"], y=band["lo"], mode="lines",
                  name=f"{colname} lo", fill='tonexty', line=dict(width=0), showlegend=False))

fig.update_yaxes(autorange="reversed", title_text="Lap Time (s)")
fig.update_xaxes(title_text="Lap in Stint")
fig.update_layout(title=f"Tyre degradation fits — Driver {DRIVER} | {YEAR} {RACE}", legend=dict(
    itemsizing='constant'))
fig.show()

# --- PRINT SUMMARY STATISTICS ---
print("\nFit summary (params: L0, a, b, c):")
for key, res in fit_results.items():
    compound, stint = key
    print(
        f" - {compound} / stint {stint}: params = {np.round(res['params'], 4)} (N={len(res['x'])})")

# Optional: return objects for downstream usage (if running as module)
results_package = {
    "laps_raw": laps,
    "laps_clean": laps_clean,
    "fits": fit_results,
    "bootstrap": bootstrap_bands,
    "degradation": deg_rates,
}
