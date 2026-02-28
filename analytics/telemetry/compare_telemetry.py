"""
Compare telemetry of two drivers' fastest laps with:
 - Speed traces (corner markers, top-speed highlights)
 - Δ-speed trace (where each driver is faster)
 - Gear at corners (smoothed)
 - Apex speeds per corner
 - Throttle & Brake traces (if available)
 - Sector times table & sector deltas
 - Robust team color & plotting fallbacks
"""

import fastf1
import fastf1.plotting
import matplotlib.pyplot as plt
import matplotlib.ticker as mtick
import pandas as pd
import numpy as np
from matplotlib.lines import Line2D

# -------------------------
# User-config
# -------------------------
fastf1.plotting.setup_mpl(mpl_timedelta_support=True, color_scheme='fastf1')
fastf1.Cache.enable_cache('analytics/cache')  # change as needed

YEAR = 2025
EVENT = 'Abu Dhabi Grand Prix'
SESSION_TYPE = 'Q'   # 'Q' for qualifying, 'R' for race, 'FP1' etc.
DRIVER1 = '1'  # can be driver number or 'VER', 'HAM', etc.
DRIVER2 = '4'

# -------------------------
# Load session and laps
# -------------------------
session = fastf1.get_session(YEAR, EVENT, SESSION_TYPE)
session.load(laps=True, telemetry=True)  # explicit load

lap1 = session.laps.pick_drivers(DRIVER1).pick_fastest()
lap2 = session.laps.pick_drivers(DRIVER2).pick_fastest()

# defensive checks
if lap1 is None or lap2 is None:
    raise ValueError(
        "Could not find fastest lap for one of the drivers. Check IDs or session availability.")

# readable names
driver1_name = lap1['Driver']
driver2_name = lap2['Driver']
team1 = lap1['Team']
team2 = lap2['Team']

# -------------------------
# Telemetry (add Distance)
# -------------------------
tel1 = lap1.get_car_data().add_distance()  # DataFrame
tel2 = lap2.get_car_data().add_distance()

# Ensure Distance columns exist
for tel in (tel1, tel2):
    if 'Distance' not in tel.columns:
        raise KeyError("Telemetry missing 'Distance' column.")

# Align distance origins to zero for each lap (helps comparison visually)
tel1['Distance'] = tel1['Distance'] - tel1['Distance'].min()
tel2['Distance'] = tel2['Distance'] - tel2['Distance'].min()

# -------------------------
# Standardize and safe-access telemetry columns
# -------------------------


def safe_col(df, *choices):
    """Return first available column name from choices, else None."""
    for c in choices:
        if c in df.columns:
            return c
    return None


speed_col = safe_col(tel1, 'Speed') or safe_col(tel2, 'Speed')
if speed_col is None:
    raise KeyError("No 'Speed' column available in telemetry.")

# gear: prefer 'nGear', fallback 'Gear'
gear_col = safe_col(tel1, 'nGear', 'Gear') or safe_col(tel2, 'nGear', 'Gear')
# throttle/brake (names commonly: 'Throttle', 'Brake', 'BrakePct')
throttle_col = safe_col(tel1, 'Throttle') or safe_col(tel2, 'Throttle')
brake_col = safe_col(tel1, 'Brake', 'BrakePressure', 'BrakePct') or safe_col(
    tel2, 'Brake', 'BrakePressure', 'BrakePct')

# Smooth gear for corner sampling (median rolling)


def add_smoothed_gear(tel, gear_col):
    if gear_col is None:
        tel['GearSmoothed'] = np.nan
        return tel
    tel['GearSmoothed'] = tel[gear_col].rolling(
        5, center=True, min_periods=1).median().round().astype('Int64')
    return tel


tel1 = add_smoothed_gear(tel1, gear_col)
tel2 = add_smoothed_gear(tel2, gear_col)

# -------------------------
# Circuit corners (Distance + Number + Letter)
# -------------------------
circuit_info = session.get_circuit_info()
# circuit_info.corners should be a DataFrame (Distance, Number, Letter)
if hasattr(circuit_info, 'corners') and isinstance(circuit_info.corners, pd.DataFrame) and len(circuit_info.corners) > 0:
    corners = circuit_info.corners.reset_index(drop=True)
else:
    # fallback: create synthetic single-corner markers at sector boundaries if corners missing
    # Use sector end distances from lap telemetry as approximations
    corners = pd.DataFrame()
    # we attempt to get sector end distances from lap telemetry by splitting distances by sector cumulative times — fallback weak
    # For safety: create three "corner" markers at 25%, 50%, 75% of lap distance
    maxd = max(tel1['Distance'].max(), tel2['Distance'].max())
    corners = pd.DataFrame({
        'Distance': [maxd * 0.25, maxd * 0.50, maxd * 0.75],
        'Number': [1, 2, 3],
        'Letter': ['A', 'B', 'C']
    })

# -------------------------
# Helper: gear/apex speed at corners
# -------------------------


def gear_and_apex_speeds(tel: pd.DataFrame, corners_df: pd.DataFrame):
    gears = []
    apex_speeds = []
    for _, corner in corners_df.iterrows():
        d = corner['Distance']
        # find nearest point
        idx = (tel['Distance'] - d).abs().idxmin()
        # use smoothed gear if available, else raw
        g = tel['GearSmoothed'].loc[idx] if 'GearSmoothed' in tel.columns else (
            tel[gear_col].loc[idx] if gear_col in tel.columns else pd.NA)
        s = tel[speed_col].loc[idx]
        # convert pandas NA to python None/int
        gears.append(int(g) if pd.notna(g) else None)
        apex_speeds.append(float(s) if pd.notna(s) else None)
    return gears, apex_speeds


gears1, apex_speeds1 = gear_and_apex_speeds(tel1, corners)
gears2, apex_speeds2 = gear_and_apex_speeds(tel2, corners)

# -------------------------
# Sector times and sector deltas
# -------------------------
sectors = ['Sector1Time', 'Sector2Time', 'Sector3Time']
# defensive: if Lap lacks SectorNTime (rare), derive from cumulative times (skip then)


def safe_sector_times(lap):
    times = []
    for s in sectors:
        if s in lap.index and pd.notna(lap[s]):
            times.append(lap[s])
        else:
            times.append(pd.NaT)
    return times


sector_times1 = safe_sector_times(lap1)
sector_times2 = safe_sector_times(lap2)

# sector deltas (seconds) where possible
sector_seconds1 = [st.total_seconds() if pd.notna(
    st) and st is not pd.NaT else np.nan for st in sector_times1]
sector_seconds2 = [st.total_seconds() if pd.notna(
    st) and st is not pd.NaT else np.nan for st in sector_times2]
sector_deltas = [(sector_seconds1[i] - sector_seconds2[i]) if not (np.isnan(
    sector_seconds1[i]) or np.isnan(sector_seconds2[i])) else np.nan for i in range(3)]

# -------------------------
# Team/Color/Style logic (robust)
# -------------------------
# defaults
linestyle1 = '-'
linestyle2 = '-'
marker1 = 'o'
marker2 = 's'


def get_team_color_safe(team_name, session_obj):
    try:
        return fastf1.plotting.get_team_color(team_name, session=session_obj)
    except Exception:
        # try fallback mapping (some common teams)
        fallback_map = {
            'Mercedes': '#00D2BE', 'Red Bull': '#0600EF', 'Ferrari': '#DC0000',
            'McLaren': '#FF8700', 'Alpine': '#0090FF', 'Aston Martin': '#006F62',
            'Kick Sauber': "#1EFF00", 'Williams': '#005AFF', 'Haas': '#FFFFFF', 'Racing Bulls': '#2B4562'
        }
        return fallback_map.get(team_name.split()[0], None) or '#1f77b4'


color1 = get_team_color_safe(team1, session)
color2 = get_team_color_safe(team2, session)

if team1 == team2:
    # differentiate styles if same team
    linestyle1, linestyle2 = '-', '--'
    marker1, marker2 = 'o', 's'

# -------------------------
# Top speeds & distances
# -------------------------
idx_top1 = tel1[speed_col].idxmax()
idx_top2 = tel2[speed_col].idxmax()
top1_dist, top1_speed = tel1.loc[idx_top1,
                                 'Distance'], tel1.loc[idx_top1, speed_col]
top2_dist, top2_speed = tel2.loc[idx_top2,
                                 'Distance'], tel2.loc[idx_top2, speed_col]

# -------------------------
# Build figure & axes
# -------------------------
fig = plt.figure(constrained_layout=False, figsize=(13, 14))
gs = fig.add_gridspec(5, 1, height_ratios=[2.6, 0.8, 0.9, 0.9, 1], hspace=0.6)
ax_speed = fig.add_subplot(gs[0, 0])   # main speed trace
ax_delta = fig.add_subplot(gs[1, 0], sharex=ax_speed)  # delta speed
ax_gear = fig.add_subplot(gs[2, 0], sharex=ax_speed)   # gear at corners
ax_tb = fig.add_subplot(gs[3, 0], sharex=ax_speed)     # throttle/brake
ax_table = fig.add_subplot(gs[4, 0])                   # sector table

# Title
fig.suptitle(
    f"{EVENT} {YEAR} {SESSION_TYPE} — {driver1_name} ({lap1['LapTime']}) vs {driver2_name} ({lap2['LapTime']})",
    fontsize=14, fontweight='semibold'
)

# 1) Speed traces
ax_speed.plot(tel1['Distance'], tel1[speed_col],
              label=f"{driver1_name}", color=color1, linestyle=linestyle1, linewidth=1.7)
ax_speed.plot(tel2['Distance'], tel2[speed_col],
              label=f"{driver2_name}", color=color2, linestyle=linestyle2, linewidth=1.7)
# ax_speed.plot(tel1['Distance'], tel1[speed_col],
#               label=f"{driver1_name} {lap1['LapTime']}", color=color1, linestyle=linestyle1, linewidth=1.7)
# ax_speed.plot(tel2['Distance'], tel2[speed_col],
#               label=f"{driver2_name} {lap2['LapTime']}", color=color2, linestyle=linestyle2, linewidth=1.7)

# corner verticals + labels
ymax = max(tel1[speed_col].max(), tel2[speed_col].max()) * 1.02
for _, c in corners.iterrows():
    d = c['Distance']
    ax_speed.axvline(d, color='grey', alpha=0.12, linewidth=0.8)
    label = f"{int(c.get('Number',0))}{c.get('Letter','')}"
    ax_speed.text(d, ymax * 0.98, label, rotation=90, va='top',
                  ha='center', fontsize=8, color='grey')

# highlight top speeds
ax_speed.scatter([top1_dist], [top1_speed], color=color1,
                 edgecolors='black', s=80, zorder=6)
ax_speed.annotate(f"{top1_speed:.1f} km/h", (top1_dist, top1_speed),
                  textcoords="offset points", xytext=(0, -18), ha='center', fontsize=8,
                  bbox=dict(boxstyle='round,pad=0.2', fc='black', alpha=0.9, ec=color1, lw=0.8))
ax_speed.scatter([top2_dist], [top2_speed], color=color2,
                 edgecolors='black', marker='D', s=80, zorder=6)
ax_speed.annotate(f"{top2_speed:.1f} km/h", (top2_dist, top2_speed),
                  textcoords="offset points", xytext=(0, 14), ha='center', fontsize=8,
                  bbox=dict(boxstyle='round,pad=0.2', fc='black', alpha=0.9, ec=color2, lw=0.8))

ax_speed.set_ylabel('Speed (km/h)')
ax_speed.set_xlabel('Distance (m)')
ax_speed.set_title(
    'Speed trace (corner markers & top speeds)', fontsize=11, pad=10)
ax_speed.legend(loc='upper right', fontsize=9)
ax_speed.grid(alpha=0.12)

# 2) Δ-speed (driver1 - driver2)
# resample both telemetry on a common distance grid for reliable delta
common_dist = np.linspace(
    0, max(tel1['Distance'].max(), tel2['Distance'].max()), 1200)
s1_interp = np.interp(common_dist, tel1['Distance'], tel1[speed_col])
s2_interp = np.interp(common_dist, tel2['Distance'], tel2[speed_col])
delta = s1_interp - s2_interp

ax_delta.plot(common_dist, delta, linewidth=1.2)
ax_delta.axhline(0, color='grey', linewidth=0.6)
ax_delta.set_ylabel(
    'Δ Speed (km/h)\n(+ means faster: {})'.format(driver1_name))
ax_delta.set_xlabel('')
ax_delta.grid(alpha=0.09)

# 3) Gear at corners (discrete markers)
ax_gear.plot(corners['Distance'], gears1, marker=marker1,
             linestyle=linestyle1, label=f"{driver1_name} Gear", color=color1)
ax_gear.plot(corners['Distance'], gears2, marker=marker2,
             linestyle=linestyle2, label=f"{driver2_name} Gear", color=color2)
for i, row in corners.iterrows():
    # annotate with corner label above marker
    label = f"{int(row.get('Number',0))}{row.get('Letter','')}"
    g1 = gears1[i] if i < len(gears1) else None
    g2 = gears2[i] if i < len(gears2) else None
    ypos = max(filter(lambda x: x is not None, [g1, g2] + [1])) + 0.4
    ax_gear.text(row['Distance'], ypos, label, ha='center', fontsize=8)
ax_gear.set_ylabel('Gear')
ax_gear.set_xlabel('Distance (m)')
ax_gear.set_title('Gear used at corner apexes (smoothed)', fontsize=11, pad=8)
ax_gear.legend(fontsize=9)
ax_gear.grid(alpha=0.08)

# 4) Throttle & Brake (if available)
if throttle_col or brake_col:
    if throttle_col and throttle_col in tel1.columns:
        ax_tb.plot(tel1['Distance'], tel1[throttle_col],
                   label=f"{driver1_name} Throttle", linestyle='-', linewidth=1)
    if throttle_col and throttle_col in tel2.columns:
        ax_tb.plot(tel2['Distance'], tel2[throttle_col],
                   label=f"{driver2_name} Throttle", linestyle='--', linewidth=1)
    if brake_col and brake_col in tel1.columns:
        ax_tb.plot(tel1['Distance'], tel1[brake_col],
                   label=f"{driver1_name} Brake", linestyle=':', linewidth=1)
    if brake_col and brake_col in tel2.columns:
        ax_tb.plot(tel2['Distance'], tel2[brake_col],
                   label=f"{driver2_name} Brake", linestyle='-.', linewidth=1)

    ax_tb.set_ylabel('Throttle / Brake')
    ax_tb.set_xlabel('Distance (m)')
    ax_tb.set_title('Driver Inputs (if available in telemetry)',
                    fontsize=11, pad=8)
    ax_tb.legend(fontsize=8)
    ax_tb.grid(alpha=0.08)
else:
    ax_tb.text(0.5, 0.5, 'Throttle / Brake not available in telemetry',
               ha='center', va='center', transform=ax_tb.transAxes)
    ax_tb.axis('off')

# 5) Sector times table with sector deltas
ax_table.axis('off')
sector_labels = ['Sector 1', 'Sector 2', 'Sector 3']
table_data = []
for i in range(3):
    s1 = f"{sector_seconds1[i]:.3f}" if not np.isnan(
        sector_seconds1[i]) else "N/A"
    s2 = f"{sector_seconds2[i]:.3f}" if not np.isnan(
        sector_seconds2[i]) else "N/A"
    delta_txt = f"{sector_deltas[i]:+.3f}" if not np.isnan(
        sector_deltas[i]) else "N/A"
    table_data.append([sector_labels[i], s1, s2, delta_txt])

col_labels = ['Sector', f'{driver1_name}', f'{driver2_name}',
              f'Delta ({driver1_name}-{driver2_name})']
table = ax_table.table(cellText=table_data, cellColours=[['black']*4]*3, colLabels=col_labels, loc='center', cellLoc='center',
                       colColours=['black', color1, color2, 'black'])
table.auto_set_font_size(False)
table.set_fontsize(11)
table.scale(1, 1.4)

ax_table.set_title(
    'Sector times (seconds) and sector deltas', fontsize=11, pad=8)

# # 6) Small summary box for apex speeds and gears
# apex_summary_lines = []
# for i, row in corners.iterrows():
#     cn = f"{int(row.get('Number',0))}{row.get('Letter','')}"
#     a1 = f"{apex_speeds1[i]:.1f} km/h" if apex_speeds1[i] is not None else "N/A"
#     a2 = f"{apex_speeds2[i]:.1f} km/h" if apex_speeds2[i] is not None else "N/A"
#     g1 = str(gears1[i]) if gears1[i] is not None else "N/A"
#     g2 = str(gears2[i]) if gears2[i] is not None else "N/A"
#     apex_summary_lines.append(
#         f"{cn}: {driver1_name} {a1} @G{g1}  |  {driver2_name} {a2} @G{g2}")

# # put apex summary as annotation below figure
# apex_text = "\n".join(apex_summary_lines)
# fig.text(0.02, 0.02, "Apex summary:\n" + apex_text, fontsize=9, va='bottom',
#          ha='left', bbox=dict(facecolor='white', alpha=0.8, edgecolor='none'))

plt.savefig(f'analytics/outputs/telemetry/compare_telemetry_{YEAR}_{EVENT}_{SESSION_TYPE}_{DRIVER1}_vs_{DRIVER2}.png', bbox_inches='tight', dpi=300)
# tidy
plt.tight_layout(rect=(0, 0.01, 1, 0.96))
plt.show()
