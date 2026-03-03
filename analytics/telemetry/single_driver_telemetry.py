import fastf1
import fastf1.plotting
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
from matplotlib.collections import LineCollection
from matplotlib.colors import ListedColormap

# -------------------------
# User-config
# -------------------------
fastf1.plotting.setup_mpl(mpl_timedelta_support=True, color_scheme='fastf1')
fastf1.Cache.enable_cache('analytics/cache')  # Ensure this path exists or matches your setup


def get_session_config():
    """
    Helper to select between a Race Session or Pre-Season Testing.
    Returns the appropriate session object.
    """
    year = 2025 
    mode = 'RACE'  # Options: 'RACE', 'TESTING'

    if mode == 'RACE':
        event = "Monza"
        session_type = "Q"
        return fastf1.get_session(year, event, session_type)

    elif mode == 'TESTING':
        test_number = 2
        session_number = 3
        return fastf1.get_testing_session(year, test_number, session_number)

    raise ValueError(f"Unknown mode: {mode}")

# -------------------------
# Load session and laps
# -------------------------
DRIVER = '4'  # Can be driver number or name like 'VER', 'HAM', etc.
session = get_session_config()
print(f"Loading {session.name}...")
session.load(laps=True, telemetry=True)

# helper to ensure variables exist for the rest of the script
YEAR = session.event.year
EVENT = session.event.EventName
# TEST_NUMBER = getattr(session, 'test', None)  # Only for testing sessions
SESSION_TYPE = session.name


print(f"Analyzing driver {DRIVER}...")
lap = session.laps.pick_driver(DRIVER).pick_fastest()

if lap is None:
    raise ValueError(f"Could not find fastest lap for driver {DRIVER}.")

driver_name = lap['Driver']
team_name = lap['Team']
lap_time = lap['LapTime']

# -------------------------
# Telemetry Processing
# -------------------------
tel = lap.get_car_data().add_distance()

# Determine available columns
def safe_col(df, *choices):
    for c in choices:
        if c in df.columns:
            return c
    return None

speed_col = safe_col(tel, 'Speed')
rpm_col = safe_col(tel, 'RPM')
gear_col = safe_col(tel, 'nGear', 'Gear')
throttle_col = safe_col(tel, 'Throttle')
brake_col = safe_col(tel, 'Brake', 'BrakePressure', 'BrakePct')
drs_col = safe_col(tel, 'DRS')

if not speed_col:
    raise ValueError("Speed telemetry missing.")

# Smooth gear for visualization
if gear_col:
    tel['GearSmoothed'] = tel[gear_col].rolling(5, center=True, min_periods=1).median().round()

# -------------------------
# Circuit / Corner Info
# -------------------------
circuit_info = session.get_circuit_info()
corners = pd.DataFrame()
if hasattr(circuit_info, 'corners') and isinstance(circuit_info.corners, pd.DataFrame):
    corners = circuit_info.corners

# -------------------------
# Plotting
# -------------------------
# Layout: Speed, RPM/Gear, Throttle/Brake, Info Table
fig = plt.figure(figsize=(12, 14), constrained_layout=True)
gs = fig.add_gridspec(4, 1, height_ratios=[3, 2, 2, 1])

ax_speed = fig.add_subplot(gs[0])
ax_tech = fig.add_subplot(gs[1], sharex=ax_speed) # RPM & Gear
ax_control = fig.add_subplot(gs[2], sharex=ax_speed) # Throttle & Brake
ax_table = fig.add_subplot(gs[3])

# Get Team Color
try:
    color = fastf1.plotting.get_team_color(team_name, session=session)
except:
    color = 'white'

# Title
fig.suptitle(f"{driver_name} ({team_name}) - {session.event['EventName']} {session.event.year}\nFastest Lap: {lap_time}", 
             fontsize=16, fontweight='bold')

# --- 1. Speed Trace ---
ax_speed.plot(tel['Distance'], tel[speed_col], color=color, linewidth=2, label='Speed')

# Highlight top speed
idx_top = tel[speed_col].idxmax()
top_dist = tel.loc[idx_top, 'Distance']
top_speed = tel.loc[idx_top, speed_col]

ax_speed.scatter(top_dist, top_speed, color='white', edgecolor=color, s=100, zorder=5)
ax_speed.annotate(f"{top_speed:.0f} km/h", (top_dist, top_speed),
                  xytext=(0, 10), textcoords="offset points", ha='center', fontsize=10,
                  bbox=dict(boxstyle='round,pad=0.2', fc='black', ec='white', alpha=0.8))

# Mark Corners
for _, corner in corners.iterrows():
    ax_speed.axvline(corner['Distance'], color='grey', linestyle='--', alpha=0.3)
    ax_speed.text(corner['Distance'], ax_speed.get_ylim()[0], 
                  f"{corner['Number']}{corner.get('Letter', '')}", 
                  rotation=90, verticalalignment='bottom', fontsize=8, color='grey')

ax_speed.set_ylabel('Speed (km/h)')
ax_speed.grid(True, which='both', linestyle='--', linewidth=0.5, alpha=0.4)
ax_speed.legend(loc='upper right')

# --- 2. Technical (RPM & Gear) ---
# RPM on left axis
if rpm_col:
    ax_tech.plot(tel['Distance'], tel[rpm_col], color='cyan', linewidth=1, label='RPM', alpha=0.7)
    ax_tech.set_ylabel('RPM', color='cyan')
    ax_tech.tick_params(axis='y', labelcolor='cyan')

# Gear on right axis
if gear_col:
    ax_gear = ax_tech.twinx()
    start_dist = tel['Distance'].iloc[0]
    
    # Draw gear graphically as steps
    ax_gear.step(tel['Distance'], tel['GearSmoothed'], where='mid', color='white', linewidth=1.5, label='Gear')
    ax_gear.set_ylabel('Gear', color='white')
    ax_gear.set_ylim(0, 9)
    ax_gear.set_yticks(range(1, 9))
    ax_gear.tick_params(axis='y', labelcolor='white')

ax_tech.grid(True, axis='x', linestyle='--', linewidth=0.5, alpha=0.4)
ax_tech.set_title("Engine RPM & Gear Usage", fontsize=10)

# --- 3. Control Inputs (Throttle & Brake) ---
if throttle_col:
    ax_control.plot(tel['Distance'], tel[throttle_col], color='green', label='Throttle', linewidth=1.5)

if brake_col:
    # Normalize brake if it's pressure (often > 100) or just plot raw if pct
    brake_data = tel[brake_col]
    # Simple check if it looks like pressure (e.g. max > 100), maybe normalize or plot on secondary
    # For simplicity in this view, we plot as is, usually 0-100 for Pct or boolean-ish
    ax_control.plot(tel['Distance'], brake_data, color='red', label='Brake', linewidth=1.5, alpha=0.8)

if drs_col:
    # DRS typically 0-14ish (status codes). 10/12/14 often means open. 
    # Let's just shade regions where DRS > 8 (simplified assumption for F1)
    drs_on = tel[tel[drs_col] > 8]
    # Should ideally find segments
    # Simple scatter for active moments or fill_between
    # A fill usually looks better:
    ax_control.fill_between(tel['Distance'], 0, 100, where=(tel[drs_col] > 8), 
                            color='orange', alpha=0.15, label='DRS Active')

ax_control.set_ylabel('Input %')
ax_control.set_ylim(-5, 105)
ax_control.legend(loc='upper right')
ax_control.grid(True, which='both', linestyle='--', linewidth=0.5, alpha=0.4)
ax_control.set_xlabel('Distance (m)')

# --- 4. Sector Stats Table ---
ax_table.axis('off')

# Data Calculation
sectors = ['Sector1Time', 'Sector2Time', 'Sector3Time']
sector_times = []
for s in sectors:
    val = lap.get(s)
    if pd.notna(val):
        sector_times.append(f"{val.total_seconds():.3f} s")
    else:
        sector_times.append("N/A")

stats_data = [
    ["Lap Time", str(lap_time).split('days ')[-1]],
    ["Top Speed", f"{top_speed:.1f} km/h"],
    ["Sector 1", sector_times[0]],
    ["Sector 2", sector_times[1]],
    ["Sector 3", sector_times[2]],
    ["Tyre", f"{lap.get('Compound', 'Unknown')} ({lap.get('TyreLife', 'N/A')} laps old)"]
]

# Create Table
table = ax_table.table(cellText=stats_data, 
                       colWidths=[0.3, 0.5],
                       loc='center', 
                       cellLoc='left',
                       edges='horizontal')

table.auto_set_font_size(False)
table.set_fontsize(12)
table.scale(1, 1.8)

# Styling table
for (row, col), cell in table.get_celld().items():
    cell.set_edgecolor('white')
    cell.set_text_props(color='white')
    if col == 0:
        cell.set_text_props(fontweight='bold', color='lightgrey')

# Save
# output_path = f"analytics/outputs/telemetry/driver_telemetry_{session.event.year}_{session.event['EventName']}_{DRIVER}.png"
output_path = f"analytics/outputs/telemetry/driver_telemetry_{YEAR}_{EVENT}_{SESSION_TYPE}_{DRIVER}.png"
print(f"Saving plot to {output_path}")
plt.savefig(output_path, dpi=300, bbox_inches='tight')
plt.show()
