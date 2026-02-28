"""Team Pace Comparison
=============================================
Rank team's race pace from the fastest to the slowest.
"""

import seaborn as sns
from matplotlib import pyplot as plt
from matplotlib.ticker import FuncFormatter

import fastf1
import fastf1.plotting

# Activate FastF1 colors (keep minimal modifications)
fastf1.plotting.setup_mpl(mpl_timedelta_support=False, misc_mpl_mods=False)
fastf1.Cache.enable_cache('analytics/cache')
sns.set_theme(style="darkgrid", context="talk")

###############################################################################
# Load the race session.
year = 2025
event = "Qatar Grand Prix"
race = fastf1.get_session(year, event, 'R')
race.load()

# Pick all quick laps (within 107% of fastest lap).
laps = race.laps.pick_quicklaps()

###############################################################################
# Convert lap times to float seconds for seaborn.
transformed_laps = laps.copy()
transformed_laps.loc[:, "LapTime (s)"] = laps["LapTime"].dt.total_seconds()

# Order teams by median lap time (fastest first)
team_order = (
    transformed_laps[["Team", "LapTime (s)"]]
    .groupby("Team")
    .median()["LapTime (s)"]
    .sort_values()
    .index
)

team_palette = {
    team: fastf1.plotting.get_team_color(team, race)
    for team in team_order
}

median_by_team = transformed_laps.groupby("Team")["LapTime (s)"].median()
fastest_median = median_by_team.min()
lap_counts = transformed_laps.groupby("Team").size()

def format_lap_time(x, _):
    m, s = divmod(x, 60)
    return f"{int(m)}:{s:05.2f}"

###############################################################################
# TEAM PLOT
fig, ax = plt.subplots(figsize=(18, 10))

sns.boxplot(
    data=transformed_laps,
    x="Team",
    y="LapTime (s)",
    order=team_order,
    palette=team_palette,
    width=0.55,
    showcaps=False,
    fliersize=0,
    boxprops=dict(edgecolor="white", linewidth=1),
    whiskerprops=dict(color="white", linewidth=1),
    medianprops=dict(color="white", linewidth=1.5),
)

sns.stripplot(
    data=transformed_laps,
    x="Team",
    y="LapTime (s)",
    order=team_order,
    color="black",
    size=3,
    alpha=0.55,
    jitter=0.25,
    ax=ax
)

for delta, style in [(0.0, 'solid'), (0.5, 'dotted'), (1.0, 'dotted')]:
    ax.axhline(fastest_median + delta, color='grey', ls=style, lw=0.8, alpha=0.8)
ax.text(
    0.02, 0.02,
    "Ref: fastest median / +0.5s / +1.0s",
    transform=ax.transAxes,
    color="grey",
    fontsize=10
)

for i, team in enumerate(team_order):
    med = median_by_team[team]
    delta = med - fastest_median
    if delta < 1e-3:
        label = f"{med:.2f}s\nBest"
    else:
        label = f"{med:.2f}s\n+{delta:.2f}"
    ax.text(
        i, med,
        label,
        ha='center',
        va='bottom',
        fontsize=9,
        fontweight='bold',
        color='white',
        bbox=dict(boxstyle="round,pad=0.25", fc='black', ec='none', alpha=0.55)
    )

ax.set_xticklabels([f"{t}\n(n={lap_counts[t]})" for t in team_order], rotation=0)
ax.invert_yaxis()
ax.yaxis.set_major_formatter(FuncFormatter(format_lap_time))
ax.set_ylabel("Lap Time (m:ss.xx)")
ax.set_xlabel(None)
plt.title(f"{event} {year} - Team Race Pace", fontsize=20, pad=14)
ax.grid(axis='y', color='0.3', alpha=0.3)
ax.grid(axis='x', visible=False)
plt.tight_layout()
plt.savefig(f"analytics/outputs/race_pace/{year}_{event.replace(' ', '_')}_team_pace.png", bbox_inches='tight', dpi=300)

###############################################################################
# DRIVER PLOT
# Driver order by median lap time
driver_order = (
    transformed_laps[["Driver", "LapTime (s)"]]
    .groupby("Driver")
    .median()["LapTime (s)"]
    .sort_values()
    .index
)
driver_medians = transformed_laps.groupby("Driver")["LapTime (s)"].median()
driver_fastest = driver_medians.min()
driver_counts = transformed_laps.groupby("Driver").size()

# Map driver to team color
driver_team_map = transformed_laps.set_index("Driver")["Team"].to_dict()
driver_palette = {
    drv: team_palette.get(driver_team_map[drv], fastf1.plotting.get_team_color(driver_team_map[drv], race))
    for drv in driver_order
}

fig2, ax2 = plt.subplots(figsize=(25, 12))

# Use boxplot + swarm for distribution
sns.boxplot(
    data=transformed_laps,
    x="Driver",
    y="LapTime (s)",
    order=driver_order,
    palette=driver_palette,
    width=0.6,
    showcaps=False,
    fliersize=0,
    boxprops=dict(edgecolor="white", linewidth=0.9),
    whiskerprops=dict(color="white", linewidth=0.9),
    medianprops=dict(color="white", linewidth=1.4),
    ax=ax2
)

sns.stripplot(
    data=transformed_laps,
    x="Driver",
    y="LapTime (s)",
    order=driver_order,
    color="black",
    size=2.8,
    alpha=0.5,
    jitter=0.25,
    ax=ax2
)

# Reference lines (same deltas as team plot)
for delta, style in [(0.0, 'solid'), (0.5, 'dotted'), (1.0, 'dotted')]:
    ax2.axhline(driver_fastest + delta, color='grey', ls=style, lw=0.75, alpha=0.75)

# Annotate driver medians (+delta)
for i, drv in enumerate(driver_order):
    med = driver_medians[drv]
    delta = med - driver_fastest
    lbl = f"{med:.2f}s" if delta < 1e-3 else f"{med:.2f}s\n+{delta:.2f}"
    ax2.text(
        i, med,
        lbl,
        ha='center',
        va='bottom',
        fontsize=8,
        color='white',
        bbox=dict(boxstyle="round,pad=0.25", fc='black', ec='none', alpha=0.5)
    )

# X tick labels with count + team
ax2.set_xticklabels([
    f"{drv}\n{driver_team_map.get(drv,'')}\n(n={driver_counts[drv]})"
    for drv in driver_order
], rotation=0)

ax2.invert_yaxis()
ax2.yaxis.set_major_formatter(FuncFormatter(format_lap_time))
ax2.set_ylabel("Lap Time (m:ss.xx)")
ax2.set_xlabel(None)
ax2.set_title(f"{event} {year} - Driver Race Pace", fontsize=20, pad=16)
ax2.grid(axis='y', color='0.3', alpha=0.3)
ax2.grid(axis='x', visible=False)
plt.tight_layout()
plt.savefig(f"analytics/outputs/race_pace/{year}_{event.replace(' ', '_')}_driver_pace.png", bbox_inches='tight', dpi=300)
plt.show()