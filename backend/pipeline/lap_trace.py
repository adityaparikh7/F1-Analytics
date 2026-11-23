"""
F1 Pitwall — single-lap telemetry traces for lap comparison

One lap of one driver, in the same coordinates as the race replay (metres, rotated to the TV
orientation, with elevation), so the telemetry page can drive the replay's 2D map, follow cam
and 3D view with laps instead of a whole race. Each trace also carries the car channels (speed,
RPM, throttle, brake, gear, DRS) on the lap's own clock, starting at 0 at the line.

Loading a session with telemetry is the expensive part (seconds from the FastF1 cache), and a
comparison asks for several laps of the same session one after another, so the most recently
loaded session is kept in memory.
"""

from __future__ import annotations

import logging
from collections import OrderedDict

import fastf1
import numpy as np
import pandas as pd

from backend.pipeline import replay_math as rm
from backend.pipeline.fastf1_cache import FASTF1_LOCK
from backend.pipeline.ingest import _init_fastf1
from backend.pipeline.replay import _circuit, parse_session_key

logger = logging.getLogger(__name__)

#: Loaded sessions kept in memory (a race with telemetry is a few hundred MB).
SESSION_CACHE_SIZE = 1
#: DRS channel values meaning the flap is open.
DRS_OPEN = (10, 12, 14)

_sessions: OrderedDict[str, fastf1.core.Session] = OrderedDict()
_layouts: dict[str, dict] = {}


class LapNotFound(ValueError):
    """The driver or lap isn't in this session."""


def load_session(session_key: str):
    """A session with laps and telemetry loaded, reusing the last one asked for."""
    with FASTF1_LOCK:
        if session_key in _sessions:
            _sessions.move_to_end(session_key)
            return _sessions[session_key]
        year, rnd, stype = parse_session_key(session_key)
        _init_fastf1()
        session = fastf1.get_session(year, rnd, stype)
        session.load(laps=True, telemetry=True, weather=False, messages=False)
        _sessions[session_key] = session
        while len(_sessions) > SESSION_CACHE_SIZE:
            _sessions.popitem(last=False)
        return session


def track_layout(session, session_key: str) -> dict:
    """Rotation and corners, exactly as the race replay draws them."""
    if session_key not in _layouts:
        with FASTF1_LOCK:
            rotation, corners = _circuit(session, session_key)
        _layouts[session_key] = {"rotation": rotation, "corners": corners}
    return _layouts[session_key]


def pick_lap(session, driver: str, lap: str):
    """``lap`` is a lap number or ``fastest``; ``driver`` an abbreviation or car number."""
    laps = session.laps.pick_drivers(driver.upper())
    if laps.empty:
        raise LapNotFound(f"No laps for driver {driver}")
    if lap == "fastest":
        chosen = laps.pick_fastest()
        if chosen is None or (isinstance(chosen, pd.Series) and chosen.empty):
            raise LapNotFound(f"No timed lap for {driver}")
        return chosen
    try:
        number = int(lap)
    except ValueError:
        raise LapNotFound(f"Invalid lap: {lap}")
    rows = laps[laps["LapNumber"] == number]
    if rows.empty:
        raise LapNotFound(f"{driver} has no lap {number}")
    return rows.iloc[0]


def _seconds(v) -> float | None:
    if v is None or pd.isna(v):
        return None
    return round(float(v.total_seconds()), 3)


def _round_list(values, nd: int) -> list:
    arr = np.asarray(values, dtype=float)
    return [None if not np.isfinite(v) else round(float(v), nd) for v in arr]


def trace_from_telemetry(tel: pd.DataFrame, rotation: float) -> dict:
    """
    Column arrays from a FastF1 lap telemetry frame: time from the line (s), distance (m),
    rotated position and elevation (m), and the car channels. Samples at (0, 0) — FastF1's
    padding for missing position data — are dropped.
    """
    tel = tel[~((tel["X"] == 0) & (tel["Y"] == 0))]
    tel = tel.dropna(subset=["Time", "X", "Y"])
    if tel.empty:
        raise LapNotFound("No position data for this lap")
    t = tel["Time"].dt.total_seconds().to_numpy(float)
    t = t - t[0]
    x, y = rm.rotate_xy(tel["X"].to_numpy(float) / 10, tel["Y"].to_numpy(float) / 10, rotation)
    z = tel["Z"].to_numpy(float) / 10 if "Z" in tel.columns else np.zeros(len(tel))
    d = tel["Distance"].to_numpy(float) if "Distance" in tel.columns else np.zeros(len(tel))
    drs = tel["DRS"].to_numpy(float) if "DRS" in tel.columns else np.zeros(len(tel))
    return {
        "t": _round_list(t, 3),
        "d": _round_list(d - d[0], 1),
        "x": _round_list(x, 1),
        "y": _round_list(y, 1),
        "z": _round_list(z, 1),
        "speed": _round_list(tel["Speed"], 0),
        "throttle": _round_list(np.clip(tel["Throttle"].to_numpy(float), 0, 100), 0),
        "brake": _round_list(tel["Brake"].astype(float), 0),
        "gear": _round_list(tel["nGear"], 0),
        "rpm": _round_list(tel["RPM"], 0),
        "drs": [1 if int(v) in DRS_OPEN else 0 for v in np.nan_to_num(drs)],
    }


def build_lap_trace(session_key: str, driver: str, lap: str = "fastest") -> dict:
    session = load_session(session_key)
    chosen = pick_lap(session, driver, lap)
    with FASTF1_LOCK:
        tel = chosen.get_telemetry()
    layout = track_layout(session, session_key)

    number = str(chosen["DriverNumber"])
    team = None
    if number in session.results.index:
        team = str(session.results.loc[number, "TeamName"])
    compound = chosen.get("Compound")
    tyre_life = chosen.get("TyreLife")
    return {
        "session_key": session_key,
        "rotation": layout["rotation"],
        "corners": layout["corners"],
        "driver": str(chosen["Driver"]),
        "driver_number": number,
        "team": team,
        "lap": int(chosen["LapNumber"]),
        "lap_time": _seconds(chosen["LapTime"]),
        "sectors": [_seconds(chosen[f"Sector{i}Time"]) for i in (1, 2, 3)],
        "compound": None if compound is None or pd.isna(compound) else str(compound),
        "tyre_life": None if tyre_life is None or pd.isna(tyre_life) else int(tyre_life),
        "is_personal_best": bool(chosen.get("IsPersonalBest")) if pd.notna(chosen.get("IsPersonalBest")) else False,
        "samples": trace_from_telemetry(tel, layout["rotation"]),
    }
