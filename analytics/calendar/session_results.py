"""
prints the session results for a given session, with name and position and fastest times, and optionally with the delta to the session leader
"""

import fastf1
import pandas as pd

# Enable cache for faster loading
fastf1.Cache.enable_cache('cache')

def get_session_config():
    """
    Helper to select between a Race Session or Pre-Season Testing.
    Returns the appropriate session object.
    """
    year = 2026
    mode = 'RACE'  # Options: 'RACE', 'TESTING'

    if mode == 'RACE':
        event = "Miami"
        session_type = "SQ"
        return fastf1.get_session(year, event, session_type)

    elif mode == 'TESTING':
        test_number = 2
        session_number = 1
        return fastf1.get_testing_session(year, test_number, session_number)

    raise ValueError(f"Unknown mode: {mode}")


def format_timedelta(td):
    if pd.isnull(td):
        return "No Time"
    minutes = int(td.total_seconds() // 60)
    seconds = int(td.total_seconds() % 60)
    millis = int(round((td.total_seconds() % 1) * 1000))
    # handle rounding up to 1000
    if millis >= 1000:
        seconds += 1
        millis -= 1000
    if seconds >= 60:
        minutes += 1
        seconds -= 60
        
    if minutes > 0:
        return f"{minutes}:{seconds:02d}.{millis:03d}"
    return f"{seconds}.{millis:03d}"

def print_session_results():
    """
    Load a fastf1 session and print out the results with standings, 
    names, fastest lap, and optionally the time delta to the session leader.
    """
    
    # Load session (without telemetry and weather to save time)
    session = get_session_config()
    session.load(telemetry=False, weather=False)
    
    results = session.results
    laps = session.laps
    print(f"\n--- {session.event.year} {session.event['EventName']} {session.name} Results ---")
    
    # Determine the session type bounds
    is_race = session.name in ['Race', 'Sprint']
    is_quali = 'Qualifying' in session.name or session.name == 'Sprint Shootout'
    
    if is_race:
        print(f"{'Pos':>3} | {'Driver':<20} | {'Team':<15} | {'Grid':>4} | {'Pts':>4} | {'Laps':>4} | {'Time/Gap':<12} | {'Status'}")
        print("-" * 100)
        
        for _, row in results.iterrows():
            pos = str(int(row['Position'])) if not pd.isnull(row['Position']) else "NC"
            name = row['FullName']
            team = row['TeamName']
            driver = row['Abbreviation']
            status = row['Status']
            points = row.get('Points', 0)
            pts_str = str(int(points)) if pd.notnull(points) and points > 0 else "-"
            grid = row.get('GridPosition', 0)
            grid_str = str(int(grid)) if pd.notnull(grid) and grid > 0 else "-"
            
            # Grid change formatting
            if grid_str != "-" and pos != "NC":
                grid_change = int(grid) - int(pos)
                if grid_change > 0:
                    grid_str = f"{grid_str} (\u2191{grid_change})"
                elif grid_change < 0:
                    grid_str = f"{grid_str} (\u2193{abs(grid_change)})"
            
            # Number of laps completed by this driver
            driver_laps = laps.pick_drivers(driver)
            laps_completed = len(driver_laps)
            
            # Get the overall session race time / gap from the results data
            race_time = row['Time']
            if pd.isnull(race_time):
                time_str = "No Time"
            else:
                time_str = format_timedelta(race_time)
                if pos != "1" and time_str != "No Time":
                    time_str = f"+{time_str}"

            print(f"{pos:>3} | {name:<20} | {team[:15]:<15} | {grid_str:>10} | {pts_str:>4} | {laps_completed:>4} | {time_str:<12} | {status}")
            
    elif is_quali:
        print(f"{'Pos':>3} | {'Driver':<20} | {'Team':<15} | {'Q1 Time':<11} | {'Q2 Time':<11} | {'Q3 Time':<11} | {'Laps'}")
        print("-" * 95)
        
        for _, row in results.iterrows():
            pos = str(int(row['Position'])) if not pd.isnull(row['Position']) else "NC"
            name = row['FullName']
            team = row['TeamName']
            driver = row['Abbreviation']
            
            # Get total laps completed for Quali
            driver_laps = laps.pick_drivers(driver)
            laps_completed = len(driver_laps)
            
            # Formatting Q1, Q2, Q3 if available columns exist (sprint shootouts have SQ1/SQ2/SQ3 represented as Q1/Q2/Q3 in pandas)
            q1 = format_timedelta(row.get('Q1', pd.NaT)) if 'Q1' in row else ""
            q2 = format_timedelta(row.get('Q2', pd.NaT)) if 'Q2' in row else ""
            q3 = format_timedelta(row.get('Q3', pd.NaT)) if 'Q3' in row else ""
                
            print(f"{pos:>3} | {name:<20} | {team[:15]:<15} | {q1:<11} | {q2:<11} | {q3:<11} | {laps_completed:>4}")

    else:
        print(f"{'Pos':>3} | {'Driver':<20} | {'Team':<15} | {'Laps':>4} | {'Fastest Lap':<11} | {'Gap'}")
        print("-" * 80)
        
        session_fastest_lap = laps['LapTime'].min()
        
        for _, row in results.iterrows():
            pos = str(int(row['Position'])) if not pd.isnull(row['Position']) else "NC"
            name = row['FullName']
            team = row['TeamName']
            driver = row['Abbreviation']
            
            # Get fastest lap and laps completed for the individual driver
            driver_laps = laps.pick_drivers(driver)
            laps_completed = len(driver_laps)
            
            if not driver_laps.empty and not driver_laps['LapTime'].dropna().empty:
                fastest_lap = driver_laps['LapTime'].min()
                fastest_lap_str = format_timedelta(fastest_lap)
                
                if fastest_lap != session_fastest_lap:
                    delta = (fastest_lap - session_fastest_lap).total_seconds()
                    delta_str = f"+{delta:.3f}s"
                else:
                    delta_str = "Leader"
            else:
                fastest_lap_str = "No Time"
                delta_str = ""
                
            print(f"{pos:>3} | {name:<20} | {team[:15]:<15} | {laps_completed:>4} | {fastest_lap_str:<11} | {delta_str}")

if __name__ == '__main__':
    # Example usage:
    print_session_results()