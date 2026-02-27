"""
Compare lap times between two drivers for a given Grand Prix, showing the lap-by-lap delta (Driver B - Driver A).
"""

import fastf1
import fastf1.plotting
import matplotlib.pyplot as plt

# --- CONFIGURATION ---
YEAR = 2025
GRAND_PRIX = "Las Vegas Grand Prix"   
SESSION = "R"
DRIVER_1 = "1"         # Can use abbreviation or number
DRIVER_2 = "4"

fastf1.Cache.enable_cache('analytics/cache')
fastf1.plotting.setup_mpl(mpl_timedelta_support=True, color_scheme='fastf1')

# --- LOAD DATA ---
session = fastf1.get_session(YEAR, GRAND_PRIX, SESSION)
session.load(telemetry=False, weather=False)

laps1 = session.laps.pick_drivers(DRIVER_1).reset_index()
laps2 = session.laps.pick_drivers(DRIVER_2).reset_index()

# Only keep laps where both drivers have a valid time
laps1 = laps1.dropna(subset=["LapNumber", "Time"])
laps2 = laps2.dropna(subset=["LapNumber", "Time"])

# Merge on LapNumber (align laps)
merged = laps1[["LapNumber", "Time"]].merge(
    laps2[["LapNumber", "Time"]],
    on="LapNumber",
    suffixes=(f"_{DRIVER_1}", f"_{DRIVER_2}")
)

# Calculate time gap (positive: DRIVER_2 is behind)
merged["Gap (s)"] = (
    merged[f"Time_{DRIVER_2}"] - merged[f"Time_{DRIVER_1}"]).dt.total_seconds()

# --- PLOT ---
fig, ax = plt.subplots(figsize=(10, 5))
ax.plot(merged["LapNumber"], merged["Gap (s)"], marker="o")
ax.axhline(0, color="grey", linestyle="--", linewidth=1)
ax.set_xlabel("Lap Number")
ax.set_ylabel(f"Time Gap (s): {DRIVER_2} to {DRIVER_1}")
ax.set_title(
    f"Time Gap Between {DRIVER_1} and {DRIVER_2} - {YEAR} {GRAND_PRIX} GP")
plt.grid(True, which='major', linestyle='--', alpha=0.5)
plt.tight_layout()
plt.show()
