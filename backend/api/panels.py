"""
F1 Pitwall — Panels API Router

Serves the panel catalogue to the frontend.
Panels are registered here — the frontend reads this to populate the catalogue drawer.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["panels"])

# ── Panel catalogue ────────────────────────────────────────────────────
# This is a static registry. In the future, panels could self-register
# from the frontend build, but for now we maintain the list server-side.

PANEL_CATALOGUE = [
    {
        "id": "session-results",
        "title": "Session Results",
        "category": "session",
        "description": "Classified finishing order with gap, fastest lap, and pit stop data.",
        "defaultSize": {"w": 12, "h": 5},
        "minSize": {"w": 6, "h": 3},
    },
    {
        "id": "season-calendar",
        "title": "Season Calendar",
        "category": "session",
        "description": "Full season schedule with round numbers and session types.",
        "defaultSize": {"w": 6, "h": 4},
        "minSize": {"w": 4, "h": 3},
    },
    {
        "id": "driver-standings",
        "title": "Driver Standings",
        "category": "session",
        "description": "Driver championship standings with points progression.",
        "defaultSize": {"w": 6, "h": 5},
        "minSize": {"w": 4, "h": 3},
    },
    {
        "id": "constructor-standings",
        "title": "Constructor Standings",
        "category": "session",
        "description": "Constructor championship standings with points.",
        "defaultSize": {"w": 6, "h": 5},
        "minSize": {"w": 4, "h": 3},
    },
    {
        "id": "telemetry-explorer",
        "title": "Telemetry Explorer",
        "category": "telemetry",
        "description": "Compare driver telemetry traces — speed, throttle, brake, gear, RPM, DRS.",
        "defaultSize": {"w": 12, "h": 6},
        "minSize": {"w": 6, "h": 4},
    },
    {
        "id": "track-map",
        "title": "Track Map",
        "category": "session",
        "description": "Circuit map with mini-sector speed colouring and corner markers.",
        "defaultSize": {"w": 6, "h": 6},
        "minSize": {"w": 4, "h": 4},
    },
    {
        "id": "lap-distribution",
        "title": "Lap Time Distribution",
        "category": "performance",
        "description": "Violin/box plot of lap time distributions by driver and compound.",
        "defaultSize": {"w": 6, "h": 5},
        "minSize": {"w": 4, "h": 3},
    },
    {
        "id": "lap-progression",
        "title": "Lap Time Progression",
        "category": "performance",
        "description": "Lap-by-lap line chart for selected drivers across a session.",
        "defaultSize": {"w": 6, "h": 5},
        "minSize": {"w": 4, "h": 3},
    },
    {
        "id": "strategy-board",
        "title": "Strategy Board",
        "category": "strategy",
        "description": "Tyre stint timeline — Gantt chart with compound colours and lap counts.",
        "defaultSize": {"w": 12, "h": 5},
        "minSize": {"w": 6, "h": 3},
    },
    {
        "id": "top-speed-plot",
        "title": "Top Speed Plot",
        "category": "performance",
        "description": "Heatmap of top speeds reached for 'n' laps by drivers.",
        "defaultSize": {"w": 6, "h": 6},
        "minSize": {"w": 4, "h": 4},
    },
    {
        "id": "driving-phases-plot",
        "title": "Driving Phases Plot",
        "category": "telemetry",
        "description": "Speed, throttle, and brake at every telemetry sample plotted on the circuit map.",
        "defaultSize": {"w": 6, "h": 6},
        "minSize": {"w": 4, "h": 4},
    },
    {
        "id": "qualifying-comparison",
        "title": "Qualifying Comparison",
        "category": "telemetry",
        "description": "Head-to-head qualifying lap comparison with sector breakdown.",
        "defaultSize": {"w": 12, "h": 5},
        "minSize": {"w": 6, "h": 3},
    },
    # {
    #     "id": "speed-trace",
    #     "title": "Speed Trace",
    #     "category": "telemetry",
    #     "description": "Dual-driver speed overlay vs distance with DRS zones, throttle and brake sub-chart.",
    #     "defaultSize": {"w": 12, "h": 6},
    #     "minSize": {"w": 6, "h": 4},
    # },
    {
        "id": "position-changes",
        "title": "Position Changes",
        "category": "performance",
        "description": "Position of each driver at the end of each lap during a race or sprint.",
        "defaultSize": {"w": 12, "h": 6},
        "minSize": {"w": 6, "h": 4},
    },
    {
        "id": "aero-map",
        "title": "Aero Map",
        "category": "telemetry",
        "description": "Aero map of the teams across the circuit.",
        "defaultSize": {"w": 6, "h": 6},
        "minSize": {"w": 4, "h": 4},
    },
    {
        "id": "race-control",
        "title": "Race Control Messages",
        "category": "session",
        "description": "Log of race control messages, flags, and incidents for the session.",
        "defaultSize": {"w": 6, "h": 4},
        "minSize": {"w": 4, "h": 3},
    },
]


@router.get("/panels")
async def get_panels():
    """Return the panel catalogue."""
    return PANEL_CATALOGUE
