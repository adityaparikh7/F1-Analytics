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
# fastf1.plotting.setup_mpl(mpl_timedelta_support=False, misc_mpl_mods=False)
fastf1.Cache.enable_cache('cache')
sns.set_theme(style="darkgrid", context="talk")

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
        session_number = 1
        return fastf1.get_testing_session(year, test_number, session_number)

    raise ValueError(f"Unknown mode: {mode}")

###############################################################################
# Load the race session.
race = get_session_config()
race.load()
year = race.date.year
event = race.event['EventName']
session = race.name

# Pick all quick laps (within 107% of fastest lap).
laps = race.laps.pick_quicklaps()

###############################################################################
# Convert lap times to float seconds for seaborn.
transformed_laps = laps.copy()
transformed_laps.loc[:, "LapTime (s)"] = laps["LapTime"].dt.total_seconds()

# Order teams by mean lap time (fastest first)
team_order = (
    transformed_laps[["Team", "LapTime (s)"]]
    .groupby("Team")
    .mean()["LapTime (s)"]
    .sort_values()
    .index
)

team_palette = {
    team: fastf1.plotting.get_team_color(team, race)
    for team in team_order
}

mean_by_team = transformed_laps.groupby("Team")["LapTime (s)"].mean()
fastest_mean = mean_by_team.min()
lap_counts = transformed_laps.groupby("Team").size()

def format_lap_time(x, _):
    m, s = divmod(x, 60)
    return f"{int(m)}:{s:05.2f}"


compound_palette = {
    "SOFT": "#FF3333",
    "MEDIUM": "#FFD700",
    "HARD": "#FFFFFF",
    "INTERMEDIATE": "#3CB371",
    "WET": "#1E90FF"
}

###############################################################################
# TEAM PLOT
fig, ax = plt.subplots(figsize=(18, 10))
# black background with white grid
ax.set_facecolor('black')
fig.patch.set_facecolor('black')

sns.boxplot(
    data=transformed_laps,
    x="Team",
    y="LapTime (s)",
    order=team_order,
    palette=team_palette,
    width=0.55,
    showcaps=False,
    fliersize=0,
    showmeans=True,
    meanprops={"marker": "d", "markerfacecolor": "white", "markeredgecolor": "black", "markersize": 8},
    boxprops=dict(edgecolor="white", linewidth=1),
    whiskerprops=dict(color="white", linewidth=1),
    medianprops=dict(color="white", linewidth=1.5),
)

sns.stripplot(
    data=transformed_laps,
    x="Team",
    y="LapTime (s)",
    order=team_order,
    hue="Compound",
    palette=compound_palette,
    # color="black",
    size=3.5,
    alpha=0.6,
    jitter=0.25,
    ax=ax
)

legend1 = ax.legend(title='Compound', facecolor='black', edgecolor='white', title_fontsize=12, fontsize=10)
for text in legend1.get_texts():
    text.set_color("white")
legend1.get_title().set_color("white")

for delta, style in [(0.0, 'solid'), (0.5, 'dotted'), (1.0, 'dotted')]:
    ax.axhline(fastest_mean + delta, color='white', ls=style, lw=0.8, alpha=0.8)
ax.text(
    0.02, 0.02,
    "Ref: fastest mean / +0.5s / +1.0s",
    transform=ax.transAxes,
    color="white",
    fontsize=10
)

for i, team in enumerate(team_order):
    med = mean_by_team[team]
    delta = med - fastest_mean
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

ax.tick_params(axis='y', colors='white')

ax.set_xticklabels([f"{t}\n(n={lap_counts[t]})" for t in team_order], rotation=0, color='white')
ax.invert_yaxis()
ax.yaxis.set_major_formatter(FuncFormatter(format_lap_time))
ax.set_ylabel("Lap Time (m:ss.xx)", color='white')
ax.set_xlabel(None)
plt.title(f"{event} {year} - {session} - Team Race Pace", fontsize=20, pad=14, color='white')
ax.grid(axis='y', color='0.3', alpha=0.3)
ax.grid(axis='x', visible=False)
plt.tight_layout()
plt.savefig(f"analytics/outputs/race_pace/2026/{event.replace(' ', '_')}_{session.replace(' ', '_')}_{year}_team_pace.png", bbox_inches='tight', dpi=400)

###############################################################################
# DRIVER PLOT
# Driver order by mean lap time
driver_order = (
    transformed_laps[["Driver", "LapTime (s)"]]
    .groupby("Driver")
    .mean()["LapTime (s)"]
    .sort_values()
    .index
)
driver_means = transformed_laps.groupby("Driver")["LapTime (s)"].mean()
driver_fastest = driver_means.min()
driver_counts = transformed_laps.groupby("Driver").size()

# Map driver to team color
driver_team_map = transformed_laps.set_index("Driver")["Team"].to_dict()
driver_palette = {
    drv: team_palette.get(driver_team_map[drv], fastf1.plotting.get_team_color(driver_team_map[drv], race))
    for drv in driver_order
}

fig2, ax2 = plt.subplots(figsize=(25, 12))
ax2.set_facecolor('black')
fig2.patch.set_facecolor('black')

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
    showmeans=True,
    meanprops={"marker": "d", "markerfacecolor": "white", "markeredgecolor": "black", "markersize": 8},
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
    hue="Compound",
    # color="black",
    palette=compound_palette,
    size=3.5,
    alpha=0.6,
    jitter=0.25,
    ax=ax2
)

legend2 = ax2.legend(title='Compound', facecolor='black', edgecolor='white', title_fontsize=12, fontsize=10)
for text in legend2.get_texts():
    text.set_color("white")
legend2.get_title().set_color("white")

# Reference lines (same deltas as team plot)
for delta, style in [(0.0, 'solid'), (0.5, 'dotted'), (1.0, 'dotted')]:
    ax2.axhline(driver_fastest + delta, color='grey', ls=style, lw=0.75, alpha=0.75)

# Annotate driver medians (+delta)
for i, drv in enumerate(driver_order):
    med = driver_means[drv]
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

ax2.tick_params(axis='y', colors='white')

# X tick labels with count + team
ax2.set_xticklabels([
    f"{drv}\n{driver_team_map.get(drv,'')}\n(n={driver_counts[drv]})"
    for drv in driver_order
], rotation=0, color='white')

ax2.invert_yaxis()
ax2.yaxis.set_major_formatter(FuncFormatter(format_lap_time))
ax2.set_ylabel("Lap Time (m:ss.xx)", color='white')
ax2.set_xlabel(None)
ax2.set_title(f"{event} {year} - {session} - Driver Race Pace", fontsize=20, pad=16, color='white')
ax2.grid(axis='y', color='0.3', alpha=0.3)
ax2.grid(axis='x', visible=False)
plt.tight_layout()
plt.savefig(f"analytics/outputs/race_pace/2026/{event.replace(' ', '_')}_{session.replace(' ', '_')}_{year}_driver_pace.png", bbox_inches='tight', dpi=400)


###############################################################################
# TYRE COMPOUND ANALYSIS
# fig3, ax3 = plt.subplots(figsize=(18, 10))

# sns.boxplot(
#     data=transformed_laps,
#     x="Team",
#     y="LapTime (s)",
#     hue="Compound",
#     order=team_order,
#     palette=compound_palette,
#     fliersize=0,
#     width=0.6,
#     ax=ax3
# )

# ax3.invert_yaxis()
# ax3.yaxis.set_major_formatter(FuncFormatter(format_lap_time))

# ax3.set_title(
#     f"{event} {year} - {session} - Team Pace by Tyre Compound",
#     fontsize=20,
#     pad=15
# )

# ax3.set_ylabel("Lap Time (m:ss.xx)")
# ax3.set_xlabel(None)

# ax3.legend(title="Compound")

# plt.tight_layout()
# plt.savefig(
#     f"analytics/outputs/race_pace/2026/{year}_{event.replace(' ', '_')}_{session.replace(' ', '_')}_compound_pace.png",
#     dpi=300
# )

###############################################################################
# STINT PACE ANALYSIS

# stint_pace = (
#     transformed_laps
#     .groupby(["Team", "Stint"])["LapTime (s)"]
#     .mean()
#     .reset_index()
# )

# fig4, ax4 = plt.subplots(figsize=(18, 10))

# sns.barplot(
#     data=stint_pace,
#     x="Team",
#     y="LapTime (s)",
#     hue="Stint",
#     order=team_order,
#     palette="viridis",
#     ax=ax4
# )

# ax4.invert_yaxis()
# ax4.yaxis.set_major_formatter(FuncFormatter(format_lap_time))

# ax4.set_title(
#     f"{event} {year} - {session} - Stint Pace Comparison",
#     fontsize=20,
#     pad=15
# )

# ax4.set_ylabel("Average Lap Time")
# ax4.set_xlabel(None)

# plt.tight_layout()
# plt.savefig(
#     f"analytics/outputs/race_pace/2026/{year}_{event.replace(' ', '_')}_{session.replace(' ', '_')}_stint_pace.png",
#     dpi=300
# )

plt.show()

# print pace ranking and delta to fastest for teams and drivers
# print("Team Pace Ranking:")
# for i, team in enumerate(team_order):
#     med = mean_by_team[team]
#     delta = med - fastest_mean
#     print(f"{i+1}. {team}: {med:.2f}s (+{delta:.2f}s)")
print("\nDriver Pace Ranking:")
for i, drv in enumerate(driver_order):
    med = driver_means[drv]
    delta = med - driver_fastest
    print(f"{i+1}. {drv} ({driver_team_map.get(drv,'')}): {med:.2f}s (+{delta:.2f}s)")

###############################################################################
# RACE PACE RATING
team_delta = mean_by_team - fastest_mean
def pace_rating(delta):
    if delta <= 0.2:
        return "Elite"
    elif delta <= 1:
        return "Competitive"
    elif delta <= 2.5:
        return "Midfield"
    elif delta <= 3:
        return "Backmarkers"
    else:        
        return "Off Pace"


# race_pace_rating = team_delta.apply(pace_rating)
# print("\nRace Pace Ratings:")
# for team in team_order:
#     print(f"{team}: {race_pace_rating[team]} (delta +{team_delta[team]:.2f}s)")


###############################################################################
# PACE RANK TABLE

pace_rank_table = (
    mean_by_team
    .sort_values()
    .reset_index()
)

pace_rank_table.columns = ["Team", "Mean Lap Time (s)"]

pace_rank_table["Delta (s)"] = pace_rank_table["Mean Lap Time (s)"] - \
    fastest_mean
pace_rank_table["Rating"] = pace_rank_table["Delta (s)"].apply(pace_rating)

pace_rank_table["Mean Lap Time"] = pace_rank_table["Mean Lap Time (s)"].apply(
    lambda x: format_lap_time(x, None)
)

pace_rank_table["Delta"] = pace_rank_table["Delta (s)"].apply(
    lambda x: f"+{x:.2f}"
)

pace_rank_table.insert(0, "Rank", range(1, len(pace_rank_table) + 1))

pace_rank_table = pace_rank_table[
    ["Rank", "Team", "Mean Lap Time", "Delta", "Rating"]
]


print("\nRace Pace Ranking\n")
print(pace_rank_table.to_string(index=False))
# pace_rank_table.to_csv(
#     f"analytics/outputs/race_pace/2026/{event.replace(' ', '_')}_{session.replace(' ', '_')}_{year}_pace_ranking.csv",
#     index=False
# )
