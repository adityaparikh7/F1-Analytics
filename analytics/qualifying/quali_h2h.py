"""
Compare qualifying performance head-to-head between two drivers in the same team for a given year.
This looks at events for both drivers' final qualifying times (Q3/Q2/Q1) rather than sector times or other telemetry.
"""

from pathlib import Path
from typing import Optional, Dict, List
import sys

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# ==== EDIT THESE ====
YEAR = 2025
DRIVER_A = "4"   
DRIVER_B = "81"  
CACHE_DIR = "analytics/cache"
OUTDIR = "analytics/outputs/quali_h2h"
SHOW_PLOTS = True
SAVE_CSV = False
# =====================

# Try to import installed FastF1, else fall back to repo in workspace (../Fast-F1)
try:
    import fastf1 as f1
except ImportError:
    repo_path = Path(__file__).resolve().parents[1] / "Fast-F1"
    if repo_path.exists():
        sys.path.insert(0, str(repo_path))
        import fastf1 as f1
    else:
        raise


def enable_cache(cache_dir: Optional[str]) -> None:
    cache_dir = cache_dir or "./cache"
    f1.Cache.enable_cache(cache_dir)


def load_quali_session(year: int, round_number: int):
    try:
        s = f1.get_session(year, round_number, "Q")
        s.load()
        return s
    except Exception:
        return None


def final_quali_time(row: pd.Series) -> pd.Timedelta:
    for seg in ("Q3", "Q2", "Q1"):
        t = row.get(seg, pd.NaT)
        if pd.notna(t):
            return t
    t = row.get("Time", pd.NaT)
    return t if pd.notna(t) else pd.NaT


def find_driver_row(results: pd.DataFrame, identifier: str) -> Optional[pd.Series]:
    ident = identifier.strip().upper()
    if "Abbreviation" in results.columns:
        hit = results.loc[results["Abbreviation"].astype(str).str.upper() == ident]
        if not hit.empty:
            return hit.iloc[0]
    digits = "".join(ch for ch in ident if ch.isdigit())
    if digits:
        hit = results.loc[results["DriverNumber"].astype(str) == digits]
        if not hit.empty:
            return hit.iloc[0]
    for col in ("Driver", "FullName"):
        if col in results.columns:
            hit = results.loc[results[col].astype(str).str.upper().str.contains(ident, na=False)]
            if not hit.empty:
                return hit.iloc[0]
    return None


def fmt_td(td: pd.Timedelta) -> str:
    if pd.isna(td):
        return "-"
    total_ms = int(round(td.total_seconds() * 1000))
    minutes, rem_ms = divmod(total_ms, 60_000)
    seconds, ms = divmod(rem_ms, 1000)
    return f"{minutes}:{seconds:02d}.{ms:03d}"


def td_to_ms(td: pd.Timedelta) -> float:
    return float(td.total_seconds() * 1000.0)


def compute_event_row(s, a_id: str, b_id: str) -> Optional[Dict]:
    res = s.results
    if res is None or res.empty:
        return None

    a_row = find_driver_row(res, a_id)
    b_row = find_driver_row(res, b_id)
    if a_row is None or b_row is None:
        return None

    a_team = a_row.get("TeamName", None)
    b_team = b_row.get("TeamName", None)
    # if not a_team or not b_team or a_team != b_team:
    #     return None  # only when they are teammates at this event

    ta = final_quali_time(a_row)
    tb = final_quali_time(b_row)
    if pd.isna(ta) or pd.isna(tb):
        return None

    delta = ta - tb  # positive => A is slower
    faster = ta if ta < tb else tb
    pct = (abs(delta) / faster) * 100.0

    event = s.event
    event_name = event.get("EventName", getattr(event, "EventName", ""))
    round_no = event.get("RoundNumber", getattr(event, "RoundNumber", None))
    date_val = event.get("EventDate", getattr(event, "EventDate", None))
    date_val = getattr(date_val, "date", lambda: date_val)() if date_val is not None else None

    return {
        "Year": event.get("Year", getattr(event, "Year", None)),
        "Round": round_no,
        "Date": date_val,
        "Event": event_name,
        "Team": a_team,
        "A_Abbr": a_row.get("Abbreviation", str(a_id).upper()),
        "B_Abbr": b_row.get("Abbreviation", str(b_id).upper()),
        "A_Seg": "Q3" if pd.notna(a_row.get("Q3", pd.NaT)) else ("Q2" if pd.notna(a_row.get("Q2", pd.NaT)) else "Q1"),
        "B_Seg": "Q3" if pd.notna(b_row.get("Q3", pd.NaT)) else ("Q2" if pd.notna(b_row.get("Q2", pd.NaT)) else "Q1"),
        "A_Time": ta,
        "B_Time": tb,
        "Delta": delta,
        "DeltaPct": float(pct),
        "A_Pos": a_row.get("Position", np.nan),
        "B_Pos": b_row.get("Position", np.nan),
    }


def build_dataset(year: int, a_id: str, b_id: str) -> pd.DataFrame:
    schedule = f1.get_event_schedule(year, include_testing=False)
    rows: List[Dict] = []
    for _, ev in schedule.iterrows():
        rnd = int(ev["RoundNumber"])
        s = load_quali_session(year, rnd)
        if s is None:
            continue
        row = compute_event_row(s, a_id, b_id)
        if row is not None:
            rows.append(row)
    df = pd.DataFrame(rows).sort_values(["Year", "Round"]).reset_index(drop=True)
    return df


def summarize(df: pd.DataFrame) -> Dict:
    wins_a = (df["Delta"] < pd.Timedelta(0)).sum()
    wins_b = (df["Delta"] > pd.Timedelta(0)).sum()
    ties = (df["Delta"] == pd.Timedelta(0)).sum()
    return {
        "wins_a": int(wins_a),
        "wins_b": int(wins_b),
        "ties": int(ties),
        "mean_delta": df["Delta"].mean(),
        "median_delta": df["Delta"].median(),
        "mean_pct": float(df["DeltaPct"].mean()),
        "median_pct": float(df["DeltaPct"].median()),
    }


def plot_figures(df: pd.DataFrame, outdir: Path, title_prefix: str, show: bool) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    a_abbr = df["A_Abbr"].iloc[0]
    b_abbr = df["B_Abbr"].iloc[0]

    dfp = df.copy()
    dfp["DeltaMs"] = dfp["Delta"].apply(td_to_ms)
    dfp["A_Time_s"] = dfp["A_Time"].dt.total_seconds()
    dfp["B_Time_s"] = dfp["B_Time"].dt.total_seconds()
   

    fig, axes = plt.subplots(3, 1, figsize=(12, 14), constrained_layout=True)

    # 1) Final quali times
    # ax = axes[0]
    # ax.plot(dfp["Round"], dfp["A_Time_s"], marker="o", label=f"{a_abbr} time", color="#1f77b4")
    # ax.plot(dfp["Round"], dfp["B_Time_s"], marker="o", label=f"{b_abbr} time", color="#ff7f0e")
    # ax.set_title(f"{title_prefix} | Final Qualifying Times")
    # ax.set_xlabel("Round")
    # ax.set_ylabel("Time (s)")
    # ax.grid(True, alpha=0.3)
    # ax.legend()

    # 1) Table of Final Times and Positions
    ax = axes[0]
    ax.axis("off")
    ax.axis("tight")

    # Columns: Round, Event, A Pos, A Time, B Pos, B Time
    table_cols = ["Rnd", "Event", f"{a_abbr} Pos",
                  f"{a_abbr} Time", 
                  f"{b_abbr} Pos", 
                  f"{b_abbr} Time"
                  ]
    table_data = []

    for _, r in df.iterrows():
        p_a = int(r["A_Pos"]) if pd.notna(r["A_Pos"]) else "-"
        p_b = int(r["B_Pos"]) if pd.notna(r["B_Pos"]) else "-"
        t_a = fmt_td(r["A_Time"])
        t_b = fmt_td(r["B_Time"])

        table_data.append([
            r["Round"], r["Event"], p_a, t_a, p_b, t_b
            # r["Round"], r["Event"], p_a, p_b
        ])

    table = ax.table(
        cellText=table_data,
        colLabels=table_cols,
        loc="center",
        cellLoc="center"
    )
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1, 1.3)  # Adjust row height
    # ax.set_title(f"{title_prefix} | Qualifying Results Table", pad=10)

    # 2) Delta per event (A - B), positive => A slower
    ax = axes[1]
    colors = np.where(dfp["DeltaMs"] >= 0, "#ff0000", "#00ff00")
    ax.bar(dfp["Round"], dfp["DeltaMs"], color=colors)
    ax.axhline(0, color="black", linewidth=1)
    # ax.set_title(f"{title_prefix} | Time Delta per Round (A - B) +ve => {a_abbr} slower")
    ax.set_title(f"Time Delta per Round (A - B) +ve => {a_abbr} slower")
    ax.set_xlabel("Round")
    ax.set_ylabel("Delta (ms)")
    ax.grid(True, axis="y", alpha=0.3)

    # 3) NEW: Percentage delta per round with rolling mean
    ax = axes[2]
    mask_a_faster = dfp["DeltaMs"] < 0
    mask_b_faster = ~mask_a_faster
    # Scatter by who is faster
    ax.scatter(dfp.loc[mask_a_faster, "Round"], dfp.loc[mask_a_faster, "DeltaPct"],
               color="#2ca02c", label=f"{a_abbr} faster")
    ax.scatter(dfp.loc[mask_b_faster, "Round"], dfp.loc[mask_b_faster, "DeltaPct"],
               color="#d62728", label=f"{b_abbr} faster")
    # Rolling mean (3 events)
    # dfp["DeltaPct_MA3"] = dfp["DeltaPct"].rolling(window=3, min_periods=1).mean()
    # ax.plot(dfp["Round"], dfp["DeltaPct_MA3"], color="gray", linewidth=2, label="3-event rolling mean")
    # Mean and median lines
    y_mean = dfp["DeltaPct"].mean()
    y_median = dfp["DeltaPct"].median()
    ax.axhline(y_mean, color="gray", linestyle="--", linewidth=1, label=f"Mean: {y_mean:.2f}%")
    ax.axhline(y_median, color="black", linestyle=":", linewidth=1, label=f"Median: {y_median:.2f}%")
    # ax.set_title(f"{title_prefix} | Percentage Delta per Round (|A-B| vs faster)")
    ax.set_title(f"Percentage Delta per Round (|A-B| vs faster)")
    ax.set_xlabel("Round")
    ax.set_ylabel("Delta (%)")
    ax.grid(True, alpha=0.3)
    ax.legend()

    img_path = outdir / f"{title_prefix.replace(' ', '_').replace('|','-')}.png"
    fig.suptitle(title_prefix, y=1.02, fontsize=14)
    fig.savefig(img_path, dpi=250, bbox_inches="tight")
    if show:
        plt.show()
    else:
        plt.close(fig)
    return img_path


def main():
    enable_cache(CACHE_DIR)

    df = build_dataset(YEAR, DRIVER_A, DRIVER_B)
    if df.empty:
        print("No events where both drivers were teammates with valid qualifying times.")
        return

    a_abbr = df["A_Abbr"].iloc[0]
    b_abbr = df["B_Abbr"].iloc[0]
    team = df["Team"].iloc[0]
    summary = summarize(df)

    print(f"Teammate Qualifying H2H: {a_abbr} vs {b_abbr} | {team} | {YEAR}")
    print(f"Compared events: {len(df)}")
    print(f"Head-to-Head: {a_abbr} {summary['wins_a']} - {summary['wins_b']} {b_abbr} (ties: {summary['ties']})")
    print(f"Mean time delta (A-B): {fmt_td(summary['mean_delta'])}")
    print(f"Median time delta (A-B): {fmt_td(summary['median_delta'])}")
    print(f"Mean percentage delta (|A-B| vs faster): {summary['mean_pct']:.3f}%")
    print(f"Median percentage delta (|A-B| vs faster): {summary['median_pct']:.3f}%")
    print("")

    printable = df.copy()
    printable["A_Time"] = printable["A_Time"].map(fmt_td)
    printable["B_Time"] = printable["B_Time"].map(fmt_td)
    printable["Delta"] = printable["Delta"].map(fmt_td)
    printable["DeltaPct"] = printable["DeltaPct"].map(lambda x: f"{x:.3f}%")

    cols = ["Year", "Round", "Date", "Event", "Team",
            "A_Abbr", "A_Seg", "A_Time",
            "B_Abbr", "B_Seg", "B_Time",
            "Delta", "DeltaPct"]
    print(printable[cols].to_string(index=False))

    outdir = Path(OUTDIR)
    
    # Check if they are teammates (all rows have same team, or at least the most recent one)
    # The dataset df has a 'Team' column. If they are teammates, it should be consistent-ish.
    # We'll just grab the team from the first row as the 'representative' team if it exists.
    team_name = df["Team"].iloc[0] if "Team" in df.columns and pd.notna(df["Team"].iloc[0]) else None
    
    if team_name:
        title_prefix = f"{YEAR} {team_name} {a_abbr} vs {b_abbr} Qualifying H2H"
    else:
        title_prefix = f"{YEAR} {a_abbr} vs {b_abbr} Qualifying H2H"

    if SAVE_CSV:
        outdir.mkdir(parents=True, exist_ok=True)
        df.to_csv(outdir / f"{title_prefix.replace(' ', '_').replace('|','-')}.csv", index=False)

    img_path = plot_figures(df, outdir, title_prefix, show=SHOW_PLOTS)
    print(f"\nSaved plot: {img_path}")


if __name__ == "__main__":
    main()