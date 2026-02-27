"""
Pre-Season Testing Long-Run Pace Estimator
------------------------------------------

Extracts long stints from testing sessions and estimates:
- Base race pace
- Tyre degradation slope
- Consistency (variance)
- Composite long-run performance score
"""

import fastf1
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

from sklearn.linear_model import HuberRegressor
from sklearn.preprocessing import StandardScaler

fastf1.Cache.enable_cache('analytics/cache')


# ==============================
# Configuration
# ==============================

YEAR = 2025
EVENT = "Qatar"
SESSION_NAME = "R"   # Day 1 / Day 2 / Day 3
MIN_STINT_LAPS = 8       # Minimum laps to count as long run
PLOT = True


# ==============================
# Load Session
# ==============================

print("Loading session...")
session = fastf1.get_session(YEAR, EVENT, SESSION_NAME)
session.load()

laps = session.laps.copy()

# Remove invalid laps
laps = laps.pick_quicklaps()
laps = laps[laps['LapTime'].notna()]
laps = laps[laps['PitOutTime'].isna()]
laps = laps[laps['PitInTime'].isna()]


# Convert lap times to seconds
laps['LapTimeSeconds'] = laps['LapTime'].dt.total_seconds()


# ==============================
# Stint Extraction
# ==============================

results = []

for driver in laps['Driver'].unique():

    driver_laps = laps.pick_drivers(driver)

    # Group by stint
    for stint, stint_laps in driver_laps.groupby('Stint'):

        if len(stint_laps) < MIN_STINT_LAPS:
            continue

        compound = stint_laps['Compound'].iloc[0]

        # Create tyre age variable
        stint_laps = stint_laps.sort_values('LapNumber')
        stint_laps['TyreAge'] = np.arange(len(stint_laps))

        X = stint_laps[['TyreAge']].values
        y = stint_laps['LapTimeSeconds'].values

        # Robust regression (better for testing data)
        model = HuberRegressor()
        model.fit(X, y)

        base_pace = model.intercept_
        degradation = model.coef_[0]

        predicted = model.predict(X)

        residuals = y - predicted
        variance = np.std(residuals)

        # Composite performance score
        score = base_pace + degradation * 10  # 10-lap projection

        results.append({
            "Driver": driver,
            "Compound": compound,
            "StintLength": len(stint_laps),
            "BasePace": base_pace,
            "Degradation_per_lap": degradation,
            "ConsistencyStd": variance,
            "Projected10LapPace": score
        })


results_df = pd.DataFrame(results)

# Rank by projected race pace
results_df = results_df.sort_values("Projected10LapPace")

print("\n=== Long Run Pace Ranking ===")
print(results_df)