"""
Driving Phases Analysis for F1 Telemetry
This script analyzes the fastest lap of every race in a given season and calculates the percentage of lap distance spent in different driving phases: Full Throttle, Partial Throttle, Braking, and Coasting.
The results are visualized in a horizontal stacked bar chart, showing the distribution of driving phases for each track. 
This can help identify "power tracks" with more full throttle vs "technical tracks with more braking and coasting.
"""
import fastf1
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

# Enable cache for faster repeated access
fastf1.Cache.enable_cache('analytics/cache')  # Ensure you have a 'cache' folder or change path

def get_driving_phases(year):
    """
    Analyzes the fastest lap of every race in the given season
    and calculates percentage of lap distance spent in driving phases.
    """
    try:
        schedule = fastf1.get_event_schedule(year, include_testing=False)
    except Exception as e:
        print(f"Error fetching schedule: {e}")
        return pd.DataFrame()

    results = []

    print(f"Analyzing {year} Season...")

    for i, event in schedule.iterrows():
        # Only process races that have happened
        if not event['EventDate'] < pd.Timestamp.now():
            continue

        race_name = event['EventName']
        round_num = event['RoundNumber']
        
        print(f"Processing Round {round_num}: {race_name}")

        try:
            session = fastf1.get_session(year, round_num, 'R')
            session.load(telemetry=True, laps=True, weather=False, messages=False)
            
            # Pick fastest lap of the race
            fastest_lap = session.laps.pick_fastest()
            if fastest_lap is None: 
                print(f"  No fastest lap found for {race_name}")
                continue

            # Get telemetry
            tel = fastest_lap.get_telemetry()
            
            # Calculate distance delta between samples to weigh the phases correctly
            # (We analyze phases by distance, not time, for track characterization)
            tel['dDistance'] = tel['Distance'].diff().fillna(0)
            total_dist = tel['dDistance'].sum()

            # --- Define Phases ---
            # Note: Public API 'Brake' channel is often boolean (0 or 100/True).
            # We cannot distinguish "Partial Braking" pressure reliably without
            # acceleration integration, so we group braking.
            
            conditions = [
                (tel['Brake'] == True),                      # Braking
                (tel['Throttle'] >= 99),                     # Full Throttle
                (tel['Throttle'] > 0) & (tel['Throttle'] < 99), # Partial Throttle
                (tel['Throttle'] == 0) & (tel['Brake'] == False) # Coasting/Neutral
            ]
            choices = ['Braking', 'Full Throttle', 'Partial Throttle', 'Coasting']
            
            tel['Phase'] = np.select(conditions, choices, default='Unknown')

            # Aggregate distances per phase
            phase_dist = tel.groupby('Phase')['dDistance'].sum()
            
            # Calculate percentages
            percentages = (phase_dist / total_dist) * 100
            
            row_data = {
                'Track': race_name.replace(' Grand Prix', ''),
                'Full Throttle': percentages.get('Full Throttle', 0),
                'Partial Throttle': percentages.get('Partial Throttle', 0),
                'Braking': percentages.get('Braking', 0),
                'Coasting': percentages.get('Coasting', 0)
            }
            results.append(row_data)

        except Exception as e:
            print(f"  Skipped {race_name}: {e}")

    return pd.DataFrame(results)

def plot_driving_phases(df, year):
    if df.empty:
        print("No data to plot.")
        return

    # Set up plot
    # Sort by Full Throttle percentage to see "power tracks" vs "technical tracks"
    df = df.sort_values('Full Throttle', ascending=True)
    
    tracks = df['Track']
    phases = ['Coasting', 'Braking', 'Partial Throttle', 'Full Throttle']
    colors = ['#cccccc', '#d9534f', '#f0ad4e', '#5cb85c'] # Gray, Red, Orange, Green
    
    fig, ax = plt.subplots(figsize=(12, 8))
    
    bottom = np.zeros(len(df))
    
    for i, phase in enumerate(phases):
        values = df[phase].values
        ax.barh(tracks, values, left=bottom, label=phase, color=colors[i], edgecolor='black', linewidth=0.5)
        for j, val in enumerate(values):
            if val > 5:  # Only label if the segment is large enough
                ax.text(bottom[j] + val/2, j, f"{val:.1f}%", va='center', ha='center', color='black', fontsize=8)
        bottom += values


    ax.set_xlabel('Percentage of Lap Distance')
    ax.set_title(f'Driving Phases by Track - {year} Fastest Race Laps', fontsize=16)
    ax.legend(bbox_to_anchor=(1.05, 1), loc='upper left')
    
    # Add grid lines on X axis
    ax.xaxis.grid(True, linestyle='--', alpha=0.7)

    # save plot to file
    plt.savefig(f'analytics/outputs/driving_phases/driving_phases_{year}.png', bbox_inches='tight')
    
    plt.tight_layout()
    plt.show()

if __name__ == "__main__":
    # Analyze the 2025 season
    season_year = 2025
    df_results = get_driving_phases(season_year)
    plot_driving_phases(df_results, season_year)