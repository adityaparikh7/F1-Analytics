# F1 Analytics

A comprehensive collection of Python scripts for analyzing Formula 1 telemetry and race data using the [FastF1](https://github.com/theOehrly/Fast-F1) library. This project provides tools for visualizing race pace, comparing qualifying laps, analyzing tyre performance, and understanding driver strategies.

## Features

*   **Race Analysis**: 
    *   `compare_telemetry.py`: Compare race pace between teammates or rivals.
    *   `race_pace.py`: Analyze overall race pace distribution.
    *   `lap-deltas.py`: Visualize lap time deltas throughout a race.
    *   `long-run-pace-est.py`: Estimate long-run pace from practice sessions.
*   **Qualifying Analysis**:
    *   `compare_quali.py`: Detailed telemetry comparison of qualifying laps (speed, throttle, brake, gear).
    *   `quali_h2h.py`: Head-to-head qualifying performance analysis.
    *   `quali_years.py`: Compare qualifying performance across different years.
*   **Telemetry**:
    *   `driving-phases.py`: Analyze time spent in different driving phases (throttle, braking, coasting).
    *   `aero_setup.py`: Insights into aerodynamic setups based on speed traces.
    *   `top_speed.py`: Analyze top speeds achieved during sessions.
*   **Tyre Analysis**:
    *   `tyre-performance-modeling.py`: Advanced modeling of tyre degradation and performance evolution.
    *   `tyre-strategy.py`: Analyze tyre strategies used during the race.
<!-- *   **Miscellaneous**:
    *   `fuel_analytics.py`: Fuel consumption analysis.
    *   `overtaking_analytics.py`: Analysis of overtaking maneuvers.
    *   `weather_crossover.py`: Analyze crossover points for wet/dry weather conditions. -->
*   **Future Work**:
    *   Adding more advanced machine learning models for performance prediction.
    *   Expanding the calendar module to include historical season analysis and future race predictions.  

## Project Structure

```
analytics/
├── race/           # Scripts for race pace and strategy analysis
├── qualifying/     # Scripts for qualifying performance comparison
├── telemetry/      # detailed telemetry analysis (speed, throttle, brake)
├── tyres/          # Tyre performance and degradation modeling
├── calendar/       # Season schedule and standings
├── outputs/        # Generated charts and HTML files
└── cache/          # FastF1 cache directory
```

## Prerequisites

*   Python 3.9+
*   FastF1
*   Pandas
*   NumPy
*   Matplotlib
*   Seaborn
*   Plotly (for interactive charts)

## Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/adityaparikh7/F1-Analytics.git
    cd F1-Analytics
    ```

2.  Install the required Python packages:
    ```bash
    pip install fastf1 pandas numpy matplotlib seaborn plotly
    ```

## Usage

Most scripts are designed to be run directly. You can modify the parameters (Year, Grand Prix, Session, Drivers) at the top of each script to analyze specific races.

**Example 1: Compare Qualifying Laps**

1.  Open `analytics/qualifying/compare_quali.py`.
2.  Edit the parameters:
    ```python
    year = 2024
    event = 'Bahrain Grand Prix'
    driver1 = 'VER'
    driver2 = 'LEC'
    ```
3.  Run the script:
    ```bash
    python analytics/qualifying/compare_quali.py
    ```

**Example 2: Analyze Race Pace**

1.  Open `analytics/race/race_pace.py`.
2.  Set the `year` and `event`.
3.  Run the script:
    ```bash
    python analytics/race/race_pace.py
    ```

## Creating cache directory
You can manually set the cache directory for FastF1 to store downloaded data. This can speed up subsequent runs by avoiding repeated downloads. If the specified cache directory does not exist, you will need to create it before running the scripts.
```bash
cd analytics
mkdir cache
```
## Outputs

Generated plots and interactive HTML files are typically saved in the `analytics/outputs/` directory or displayed directly depending on the script configuration. The output directory make need to be manually created if it does not exist.
```bash
cd analytics
mkdir outputs
```

## License

This project is open-source and available under the MIT License.

## Author
Aditya Parikh - [GitHub](https://github.com/adityaparikh7)


## Acknowledgements

*   [FastF1](https://github.com/theOehrly/Fast-F1) for the incredible API providing F1 timing and telemetry data.
*   The F1 community for inspiring data analysis and visualization projects.