"""
Aero Efficiency Quadrant Plot for F1 Telemetry Analysis
This script generates a quadrant plot comparing mean lap speed against top straight-line speed for the best lap of each team in a given session. 
The plot visually categorizes teams into quadrants of high/low downforce and efficiency.
"""
# ------------------------------------------------------------
# F1 Aero Efficiency Quadrant Plot
# ------------------------------------------------------------

import fastf1
import fastf1.plotting
import numpy as np
import matplotlib.pyplot as plt
import plotly.graph_objects as go

fastf1.Cache.enable_cache('analytics/cache')

# ------------------------------------------------------------
# Global Style (Visual Identity)
# ------------------------------------------------------------
plt.rcParams.update({
    "figure.facecolor": "#f7f7f7",
    "axes.facecolor": "#ffffff",
    "axes.edgecolor": "#cccccc",
    "axes.labelsize": 14,
    "axes.titlesize": 18,
    "xtick.labelsize": 12,
    "ytick.labelsize": 12,
    "font.family": "DejaVu Sans",
    "grid.color": "#dddddd",
    "grid.linestyle": "--",
    "grid.alpha": 0.4
})


# ------------------------------------------------------------
# Utility: Compute mean & top speed from telemetry
# ------------------------------------------------------------
def get_lap_speeds(lap):
    tel = lap.get_telemetry().add_distance()

    lap_distance_m = tel['Distance'].iloc[-1]
    lap_time_s = lap['LapTime'].total_seconds()
    mean_speed = (lap_distance_m / 1000) / (lap_time_s / 3600)

    if "SpeedST" in lap and not np.isnan(lap['SpeedST']):
        top_speed = lap['SpeedST']
    else:
        top_speed = tel['Speed'].max()

    return mean_speed, top_speed


# ------------------------------------------------------------
# Main Plot
# ------------------------------------------------------------
def plot_aero_map(year, grand_prix, session_type):

    # session = fastf1.get_session(year, grand_prix, session_type)
    session = fastf1.get_session(year, grand_prix, session_type)
    session.load()

    # --------------------------------------------------------
    # Best lap per team
    # --------------------------------------------------------
    team_best_laps = {}

    for drv in session.drivers:
        laps = session.laps.pick_drivers(drv).pick_quicklaps()
        if laps.empty:
            continue

        best_lap = laps.pick_fastest()
        team = best_lap['Team']

        if team not in team_best_laps or best_lap['LapTime'] < team_best_laps[team]['LapTime']:
            team_best_laps[team] = best_lap

    teams, mean_speeds, top_speeds, colors = [], [], [], []

    for team, lap in team_best_laps.items():
        meanv, topv = get_lap_speeds(lap)
        teams.append(team)
        mean_speeds.append(meanv)
        top_speeds.append(topv)
        colors.append(fastf1.plotting.get_team_color(team, session))

    mean_speeds = np.array(mean_speeds)
    top_speeds = np.array(top_speeds)

    cx, cy = mean_speeds.mean(), top_speeds.mean()

    # --------------------------------------------------------
    # Plot
    # --------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 12))

    # Subtle quadrant shading
    ax.axvspan(mean_speeds.min(), cx, ymin=0.5,
               ymax=1, alpha=0.04, color="blue")
    ax.axvspan(cx, mean_speeds.max(), ymin=0.5,
               ymax=1, alpha=0.04, color="green")
    ax.axvspan(cx, mean_speeds.max(), ymin=0,
               ymax=0.5, alpha=0.04, color="red")
    ax.axvspan(mean_speeds.min(), cx, ymin=0,
               ymax=0.5, alpha=0.04, color="orange")

    # Soft glow
    ax.scatter(mean_speeds, top_speeds, s=360, c=colors, alpha=0.15, zorder=2)

    # Main points
    ax.scatter(
        mean_speeds,
        top_speeds,
        s=260,
        c=colors,
        edgecolors="black",
        linewidth=1.2,
        alpha=0.95,
        zorder=3
    )

    # Labels
    for i, team in enumerate(teams):
        ax.annotate(
            team,
            (mean_speeds[i], top_speeds[i]),
            xytext=(6, 6),
            textcoords="offset points",
            fontsize=11,
            weight="bold",
            bbox=dict(boxstyle="round,pad=0.25",
                      fc="white", ec="none", alpha=0.75)
        )

    # Limits
    ax.set_xlim(mean_speeds.min() - 0.6, mean_speeds.max() + 0.6)
    ax.set_ylim(top_speeds.min() - 1.2, top_speeds.max() + 1.2)

    # Tick formatting
    ax.xaxis.set_major_formatter(lambda x, _: f"{x:.1f}")
    ax.yaxis.set_major_formatter(lambda y, _: f"{y:.0f}")

    # --------------------------------------------------------
    # Quadrant Arrows (Axes Coordinates)
    # --------------------------------------------------------
    def arrow_ax(x1, y1, x2, y2, text, tx=0, ty=0):
        ax.annotate(
            "",
            xy=(x2, y2),
            xytext=(x1, y1),
            xycoords="axes fraction",
            textcoords="axes fraction",
            arrowprops=dict(arrowstyle="->", lw=1.2,
                            color="#333333", alpha=0.8)
        )
        ax.text(
            x2 + tx, y2 + ty, text,
            transform=ax.transAxes,
            fontsize=11,
            style="italic",
            color="#333333"
        )

    cx_ax, cy_ax = 0.5, 0.5

    arrow_ax(cx_ax, cy_ax, 0.20, 0.80, "Low Downforce", -0.10, 0.03)
    arrow_ax(cx_ax, cy_ax, 0.80, 0.80, "High Efficiency", 0.02, 0.03)
    arrow_ax(cx_ax, cy_ax, 0.80, 0.20, "High Downforce", 0.02, -0.12)
    arrow_ax(cx_ax, cy_ax, 0.20, 0.20, "Low Efficiency", -0.10, -0.12)

    arrow_ax(cx_ax, cy_ax, cx_ax, 0.95, "Low Drag", -0.07, 0.02)
    arrow_ax(cx_ax, cy_ax, cx_ax, 0.05, "High Drag", -0.07, -0.10)
    arrow_ax(cx_ax, cy_ax, 0.95, cy_ax, "Quick", 0.03, -0.02)
    arrow_ax(cx_ax, cy_ax, 0.05, cy_ax, "Slow", -0.10, -0.02)

    # --------------------------------------------------------
    # Titles & Labels
    # --------------------------------------------------------
    plt.suptitle(
        "Aero Efficiency Map",
        fontsize=20,
        weight="bold",
        y=0.98
    )

    ax.set_title(
        f"{year} {grand_prix} GP – {session.name}\n"
        "Mean lap speed vs peak straight-line speed",
        fontsize=13,
        color="#555555"
    )

    ax.set_xlabel("Mean Speed (km/h)")
    ax.set_ylabel("Top Speed (km/h)")

    ax.grid(True)
    plt.tight_layout(rect=[0, 0, 1, 0.95])

    plt.savefig(
        f"analytics/outputs/aero_maps/aero_map_{year}_{grand_prix}_{session_type}.png",
        dpi=300,
        bbox_inches="tight"
    )

    plt.show()


def plot_aero_map_plotly(year, grand_prix, session_type):

    session = fastf1.get_session(year, grand_prix, session_type)
    session.load()

    team_best_laps = {}

    for drv in session.drivers:
        laps = session.laps.pick_drivers(drv).pick_quicklaps()
        if laps.empty:
            continue

        best_lap = laps.pick_fastest()
        team = best_lap["Team"]

        if team not in team_best_laps or best_lap["LapTime"] < team_best_laps[team]["LapTime"]:
            team_best_laps[team] = best_lap

    teams, mean_speeds, top_speeds, colors = [], [], [], []

    for team, lap in team_best_laps.items():
        meanv, topv = get_lap_speeds(lap)
        teams.append(team)
        mean_speeds.append(meanv)
        top_speeds.append(topv)

        rgb = fastf1.plotting.get_team_color(team, session)
        colors.append(rgb)

    mean_speeds = np.array(mean_speeds)
    top_speeds = np.array(top_speeds)

    cx, cy = mean_speeds.mean(), top_speeds.mean()

    # --------------------------------------------------------
    # Scatter
    # --------------------------------------------------------
    fig = go.Figure()

    fig.add_trace(
        go.Scatter(
            x=mean_speeds,
            y=top_speeds,
            mode="markers+text",
            text=teams,
            textposition="top center",
            marker=dict(
                size=18,
                color=colors,
                line=dict(width=1.5, color="black"),
                opacity=0.95
            ),
            hovertemplate=(
                "<b>%{text}</b><br>"
                "Mean Speed: %{x:.2f} km/h<br>"
                "Top Speed: %{y:.1f} km/h<br>"
                "<extra></extra>"
            )
        )
    )

    # --------------------------------------------------------
    # Quadrant reference lines
    # --------------------------------------------------------
    fig.add_vline(x=cx, line_width=1, line_dash="dot", line_color="gray")
    fig.add_hline(y=cy, line_width=1, line_dash="dot", line_color="gray")

    # --------------------------------------------------------
    # Annotations (quadrants)
    # --------------------------------------------------------
    annotations = [
        dict(x=0.02, y=0.98, xref="paper", yref="paper",
             text="<b>Low Downforce</b>", showarrow=False),
        dict(x=0.98, y=0.98, xref="paper", yref="paper",
             text="<b>High Efficiency</b>", showarrow=False, xanchor="right"),
        dict(x=0.98, y=0.02, xref="paper", yref="paper",
             text="<b>High Downforce</b>", showarrow=False, xanchor="right"),
        dict(x=0.02, y=0.02, xref="paper", yref="paper",
             text="<b>Low Efficiency</b>", showarrow=False)
    ]

    fig.update_layout(annotations=annotations)

    # --------------------------------------------------------
    # Layout polish
    # --------------------------------------------------------
    fig.update_layout(
        title=dict(
            text=(
                f"<b>Aero Efficiency Map</b><br>"
                f"<sup>{year} {grand_prix} GP – {session.name}</sup>"
            ),
            x=0.5
        ),
        xaxis=dict(
            title="Mean Speed (km/h)",
            showgrid=True,
            zeroline=False
        ),
        yaxis=dict(
            title="Top Speed (km/h)",
            showgrid=True,
            zeroline=False
        ),
        plot_bgcolor="#ffffff",
        paper_bgcolor="#f7f7f7",
        width=900,
        height=900
    )

    fig.show()


# ------------------------------------------------------------
# Run
# ------------------------------------------------------------
plot_aero_map(2025, "Monaco", "R")
# plot_aero_map_plotly(2025, "Abu Dhabi", "R")
