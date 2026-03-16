import fastf1
from fastf1 import plotting
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

fastf1.Cache.enable_cache("cache")

def plot_race_strategy(year: int, gp: str, session_type: str):
    session = fastf1.get_session(year, gp, session_type)
    session.load()
    laps = session.laps

    # Identify SC and VSC laps
    sc_laps = laps[laps['TrackStatus'].str.contains('4', na=False)]['LapNumber'].unique()
    vsc_laps = laps[laps['TrackStatus'].str.contains('6', na=False)]['LapNumber'].unique()

    stints = laps[["Driver", "Stint", "Compound", "FreshTyre", "LapNumber"]]
    stints = stints.groupby(["Driver", "Stint", "Compound", "FreshTyre"])
    stints = stints.count().reset_index().rename(
        columns={"LapNumber": "StintLength"})

    drivers = [session.get_driver(d)["Abbreviation"] for d in session.drivers]

    plt.style.use('dark_background')
    plotting.setup_mpl()
    fig, ax = plt.subplots(figsize=(10, len(drivers)*0.4 + 2))

    # Highlight SC and VSC periods
    for lap in sc_laps:
        ax.axvspan(lap - 0.5, lap + 0.5, color='orange', alpha=0.25, zorder=10, label='Safety Car' if lap == sc_laps[0] else "")
    for lap in vsc_laps:
        ax.axvspan(lap - 0.5, lap + 0.5, color='yellow', alpha=0.25, zorder=10, label='VSC' if lap == vsc_laps[0] else "")

    for driver in drivers:
        driver_stints = stints.loc[stints["Driver"] == driver]
        previous_end = 0
        for _, row in driver_stints.iterrows():
            compound = row["Compound"]
            fresh = row["FreshTyre"]
            length = row["StintLength"]
            color = plotting.get_compound_color(compound, session=session)

            bar = ax.barh(
                y=driver,
                width=length,
                left=previous_end,
                color=color,
                edgecolor='black',
                alpha=1.0 if fresh else 0.5
            )

            # add text label: number of laps in this stint
            # place text roughly at the center of the bar
            ax.text(
                previous_end + length/2,  # x coordinate
                driver,                   # y coordinate (driver name)
                str(length),
                ha='center', va='center',
                color='black', fontsize=8
            )

            previous_end += length

    ax.set_title(f"{year} {gp} {session_type} — Tyre Strategy (all drivers)")
    ax.set_xlabel("Lap Number")
    ax.invert_yaxis()
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)

    compounds = stints["Compound"].unique()
    legend_elems = []
    for comp in compounds:
        legend_elems.append(
            mpatches.Patch(
                facecolor=plotting.get_compound_color(comp, session=session),
                edgecolor='black',
                label=comp
            )
        )
    # Add used-tyre indicator to legend
    legend_elems.append(
        mpatches.Patch(
            facecolor='grey', edgecolor='black',
            alpha=0.5, label='Used tyre (semi-transparent)'
        )
    )
    if len(sc_laps) > 0:
        legend_elems.append(mpatches.Patch(facecolor='orange', alpha=0.2, label='Safety Car'))
    if len(vsc_laps) > 0:
        legend_elems.append(mpatches.Patch(facecolor='yellow', alpha=0.2, label='Virtual Safety Car'))
        
    ax.legend(handles=legend_elems, loc='upper right')

    plt.tight_layout()
    plt.savefig(f'analytics/outputs/tyre_strategy/2026/{year}_{gp}_{session_type}_tyre_strategy.png', bbox_inches='tight', dpi=300)
    plt.show()


if __name__ == "__main__":
    year = 2026
    gp = "China"
    session_type = "Race"
    plot_race_strategy(year, gp, session_type)
