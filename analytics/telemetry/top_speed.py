"""
Plot a heatmap of top lap speeds per driver for a given session, using either official Speed Trap values or telemetry maxima.
"""
from typing import List, Dict
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import fastf1
from fastf1 import plotting


def get_session_config():
    """
    Helper to select between a Race Session or Pre-Season Testing.
    Returns the appropriate session object.
    """
    year = 2026  # Default year
    mode = 'RACE'  # Options: 'RACE', 'TESTING'

    if mode == 'RACE':
        event = "China"
        session_type = "Race"
        return fastf1.get_session(year, event, session_type)

    elif mode == 'TESTING':
        test_number = 2
        session_number = 2
        return fastf1.get_testing_session(year, test_number, session_number)

    raise ValueError(f"Unknown mode: {mode}")

def compute_driver_lap_top_speeds(session, driver: str, source: str) -> List[float]:
    """Return a list of per-lap top speeds (km/h) for a given driver.

    source:
      - "speedtrap": use official per-lap Speed Trap values (session.laps['SpeedST'])
      - "telemetry": use per-lap telemetry maxima from lap.get_car_data()['Speed']
    """
    if source == "speedtrap":
        laps = session.laps.pick_drivers(driver)
        if 'SpeedST' not in laps.columns:
            return []
        # coerce to numeric (in case of strings), drop NaN
        vals = pd.to_numeric(laps['SpeedST'], errors='coerce')
        return [float(v) for v in vals.dropna().tolist() if np.isfinite(v) and v > 50.0]

    # telemetry fallback
    laps = session.laps.pick_drivers(driver)
    speeds: List[float] = []
    for _, lap in laps.iterlaps():
        try:
            car_data = lap.get_car_data()
            if car_data is None or car_data.empty:
                continue
            vmax = float(car_data['Speed'].max())
            if np.isfinite(vmax) and vmax > 50:
                speeds.append(vmax)
        except Exception:
            continue
    return speeds


def detect_speed_source(session) -> str:
    """Detect whether per-lap official Speed Trap values are available."""
    try:
        laps = session.laps
        if ('SpeedST' in laps.columns) and (pd.to_numeric(laps['SpeedST'], errors='coerce').notna().any()):
            return "speedtrap"
    except Exception:
        pass
    return "telemetry"


def make_heatmap_df(
    session,
    top_n: int = 15,
    source: str = "telemetry"
) -> pd.DataFrame:
    """Build a DataFrame: rows=drivers, cols=Top1..TopN + Avg."""
    rows: Dict[str, List[float]] = {}

    for drv in session.drivers:
        info = session.get_driver(drv)
        label = info.get('Abbreviation', drv)

        lap_speeds = compute_driver_lap_top_speeds(session, drv, source=source)
        if not lap_speeds:
            vals = [np.nan] * top_n + [np.nan]
        else:
            sorted_desc = sorted(lap_speeds, reverse=True)
            top_vals = sorted_desc[:top_n]
            if len(top_vals) < top_n:
                top_vals = top_vals + [np.nan] * (top_n - len(top_vals))
            avg_val = float(np.mean(lap_speeds)) if lap_speeds else np.nan
            vals = top_vals + [avg_val]

        rows[label] = vals

    columns = [f"Top #{i}" for i in range(1, top_n + 1)] + ["Avg"]
    df = pd.DataFrame.from_dict(rows, orient='index', columns=columns)

    # Sort drivers by their best top speed (first column), then average as tiebreaker
    df = df.sort_values(by=[columns[0], "Avg"], ascending=[False, False])

    return df


def plot_heatmap(df: pd.DataFrame, title: str, values_note: str, save_path: str | None = None):
    # plotting.setup_mpl(misc_mpl_mods=False)
    sns.set_context("talk")

    # Choose a consistent scale across all cells
    vmin = np.nanmin(df.values)
    vmax = np.nanmax(df.values)

    # Figure size scales with number of columns and drivers
    n_cols = df.shape[1]
    n_rows = df.shape[0]
    width = max(10, 0.7 * n_cols + 3)   # add some space for labels
    height = max(6, 0.4 * n_rows + 2)

    fig, ax = plt.subplots(figsize=(width, height))
    cmap = sns.color_palette("rocket_r", as_cmap=True)

    # Build annotation strings so every box has a label (use "-" for NaN)
    annot_data = df.copy()
    annot_str = annot_data.map(
        lambda v: "-" if pd.isna(v) else f"{v:.1f}")

    hm = sns.heatmap(
        df,
        ax=ax,
        cmap=cmap,
        vmin=vmin,
        vmax=vmax,
        annot=annot_str,
        fmt="",
        linewidths=0.5,
        linecolor='white',
        cbar_kws={"label": "Top speed [km/h]"},
        annot_kws={"fontsize": 9}
    )

    # Separate the average column visually
    avg_col_idx = df.shape[1] - 1
    ax.axvline(avg_col_idx, color='white', lw=2)

    ax.set_title(title, pad=10)
    ax.set_xlabel("")
    ax.set_ylabel("Driver")

    # Sub-note specifying what values are used
    ax.text(
        1.05, 1.01, values_note,
        fontsize=9, transform=ax.transAxes, ha='left', va='bottom', color='dimgray'
    )

    plt.tight_layout()
    if save_path:
        plt.savefig(f'{save_path}/{title.replace(" ", "_")}.png', dpi=300, bbox_inches="tight")
    plt.show()


def main():
    # Hard-coded configuration
    TOP_N = 15 # how many top speeds to show per driver (in addition to the average)
    SAVE_PATH = 'analytics/outputs/top_speed'

    # Enable cache
    fastf1.Cache.enable_cache('cache')

    # Load session
    session = get_session_config()
    session.load(telemetry=True, laps=True, weather=False, messages=True)

    # Decide value source
    source = detect_speed_source(session)
    values_note = "Values: Speed Trap" if source == "speedtrap" \
                  else "Values: Telemetry Maxima"

    event = session.event
    # Construct a title using the event metadata
    # (session.event usually has 'EventName', year is session.event.year)
    event_year = event.year
    event_name_str = event.EventName
    # Session name might be in event.SessionX or we can just use the session name
    session_name = session.name

    title = f"Top Speeds Heatmap — {event_year} {event_name_str} {session_name} (Top {TOP_N} per driver + Avg)"

    df = make_heatmap_df(session, top_n=TOP_N, source=source)

    plot_heatmap(df, title=title, values_note=values_note, save_path=SAVE_PATH)


if __name__ == "__main__":
    main()
