"""
Tyre Strategy Visualization for F1 Pre-Season Testing
This script loads telemetry and lap data from a specified pre-season testing session and visualizes the tyre strategy for each driver. 
It creates a horizontal bar chart where each bar represents a stint on a particular tyre compound, with the length of the bar corresponding to the number of laps in that stint. 
Fresh tyre stints are highlighted with full opacity, while used tyre stints are shown with reduced opacity.
"""
import fastf1
import fastf1.plotting
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.ticker import FuncFormatter
import seaborn as sns
import pandas as pd
import os
import sys

# Configure FastF1 plotting
fastf1.plotting.setup_mpl(misc_mpl_mods=False)
# Enable caching
fastf1.Cache.enable_cache('analytics/cache') # Default fallback

def plot_testing_tyre_strategy(year, test_number, session_number):
    """
    Plots the tyre strategy (usage) for all drivers in a pre-season testing session.
    
    Args:
        year (int): The year of the season.
        test_number (int): The test event number (usually 1).
        session_number (int): The session number (Day 1=1, Day 2=2, etc.).
    """
    print(f"Loading data for Year: {year}, Test: {test_number}, Session: {session_number}")
    session= fastf1.get_testing_session(year, test_number, session_number)
    session.load()
    laps = session.laps

    drivers = session.drivers
    # Get driver abbreviations
    driver_list = []
    for d in drivers:
        try:
            driver_list.append(session.get_driver(d)["Abbreviation"])
        except:
            pass
    
    if not driver_list:
        print("No drivers found.")
        return False

    # Process stints
    # Group by Driver, Stint to get compound and length
    stints = laps[["Driver", "Stint", "Compound", "FreshTyre", "LapNumber"]]
    stints = stints.groupby(["Driver", "Stint", "Compound", "FreshTyre"])
    stints = stints.count().reset_index().rename(columns={"LapNumber": "StintLength"})

    # Setup the plot
    fig, ax = plt.subplots(figsize=(12, len(driver_list) * 0.5 + 2))

    for driver in driver_list:
        driver_stints = stints.loc[stints["Driver"] == driver]
        
        previous_end = 0
        for _, row in driver_stints.iterrows():
            compound = row["Compound"]
            length = row["StintLength"]
            fresh = row["FreshTyre"]
            
            # Get compound color
            try:
                color = fastf1.plotting.get_compound_color(compound, session=session)
            except:
                color = "lightgray"

            # Draw bar for the stint
            ax.barh(
                y=driver,
                width=length,
                left=previous_end,
                color=color,
                edgecolor="black",
                alpha=1.0 if fresh else 0.6
            )
            
            # Add text for stint length
            if length >= 2: # Only label if length is significant enough to fit text
                ax.text(
                    previous_end + length / 2,
                    driver,
                    str(int(length)),
                    ha='center', va='center',
                    color='black',
                    fontsize=8,
                    fontweight='bold'
                )
            
            previous_end += length

    # Styles
    event_name = session.event.EventName if hasattr(session.event, 'EventName') else f"Pre-Season Test {test_number}"
    ax.set_title(f"{year} {event_name} - Day {session_number} Tyre Usage")
    ax.set_xlabel("Lap Number")
    ax.invert_yaxis() # Drivers from top to bottom
    
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)
    
    ax.grid(axis='x', linestyle='--', alpha=0.3)

    # Legend
    compounds = stints["Compound"].unique()
    legend_handles = []
    for comp in compounds:
        try:
            c = fastf1.plotting.get_compound_color(comp, session=session)
        except:
            c = "lightgray"
        legend_handles.append(mpatches.Patch(facecolor=c, edgecolor='black', label=comp))
    
    legend_handles.append(mpatches.Patch(facecolor='gray', edgecolor='black', alpha=0.6, label='Used Tyre'))
    
    ax.legend(handles=legend_handles, loc='upper right', bbox_to_anchor=(1.15, 1))
    plt.savefig(f"analytics/outputs/testing/tyre_strategy_{year}_test{test_number}_day{session_number}.png", bbox_inches='tight', dpi=300)
    plt.tight_layout()
    plt.show()
    return True



if __name__ == "__main__":
    # Attempt to load data
    year = 2025
    test_number = 1
    session_number = 1
    success = plot_testing_tyre_strategy(year, test_number, session_number)
    
    if not success:
        print(f"\n--- {year} data load failed or incomplete.\n")


