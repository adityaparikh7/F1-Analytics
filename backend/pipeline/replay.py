"""
F1 Pitwall — Race Replay builder

Turns a FastF1 race (or sprint) into a compact, column-oriented replay: every car's position
and race progress on a uniform 4 Hz grid, plus the lap, pit stop, track status and race
control timelines needed to drive a timing tower and event feed.

This is on-demand derived data, like the FastF1 cache, not part of the eager ingest pipeline:
a replay is built the first time someone opens it and then served from
``REPLAY_CACHE_DIR/v{REPLAY_VERSION}/{session_key}/``.

Run directly to build one and print sanity checks::

    python -m backend.pipeline.replay 2024 1 R
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import sys
import time
from pathlib import Path

import fastf1
import numpy as np
import pandas as pd

from backend.config import REPLAY_CACHE_DIR
from backend.pipeline import replay_math as rm
from backend.pipeline.ingest import _init_fastf1, _make_session_key

logger = logging.getLogger(__name__)

#: Bump when the payload shape or the maths changes; old cache directories are then ignored.
REPLAY_VERSION = 1

#: Seconds of grid shown before lights out, and of cool-down after the last car finishes.
PRE_START_S = 10.0
POST_FINISH_S = 30.0

#: Track outline spacing (metres) for drawing; the projection reference is much finer.
OUTLINE_STEP_M = 10.0

#: Corner label offset in metres, the same 50 m FastF1's circuit-map example uses.
CORNER_LABEL_OFFSET_M = 50.0

#: DRS channel values meaning the flap is open.
DRS_OPEN = (10, 12, 14)

REPLAY_FILE = "replay.json.gz"
HUD_DIR = "hud"


class ReplayUnavailable(ValueError):
    """The session cannot be replayed (not a race, or no position data)."""


# ── Session keys ───────────────────────────────────────────────────────

def parse_session_key(session_key: str) -> tuple[int, int, str]:
    """``'2024_01_R'`` → ``(2024, 1, 'R')``. Raises ``ValueError`` on a malformed key."""
    parts = session_key.split("_")
    if len(parts) != 3:
        raise ValueError(f"Invalid session_key format: {session_key}")
    return int(parts[0]), int(parts[1]), parts[2]


def is_race_session(year: int, session_type: str) -> bool:
    """
    Only races and sprints have a meaningful replay. 2021's sprints were called
    "Sprint Qualifying", which the app stores as ``SQ``; from 2023 ``SQ`` is a qualifying
    shootout instead, hence the year check.
    """
    return session_type in ("R", "S") or (session_type == "SQ" and year == 2021)


# ── Cache ──────────────────────────────────────────────────────────────

def cache_dir(session_key: str) -> Path:
    return REPLAY_CACHE_DIR / f"v{REPLAY_VERSION}" / session_key


def is_cached(session_key: str) -> bool:
    """``replay.json.gz`` is written last, so its presence means the whole build landed."""
    return (cache_dir(session_key) / REPLAY_FILE).exists()


def replay_path(session_key: str) -> Path:
    return cache_dir(session_key) / REPLAY_FILE


def hud_path(session_key: str, driver_number: str) -> Path:
    return cache_dir(session_key) / HUD_DIR / f"{driver_number}.json.gz"


def _write_json_gz(path: Path, obj) -> None:
    """Atomic write: a reader never sees a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as fh:
        json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)


def write_replay_cache(session_key: str, payload: dict, huds: dict[str, dict]) -> Path:
    for number, hud in huds.items():
        _write_json_gz(hud_path(session_key, number), hud)
    _write_json_gz(replay_path(session_key), payload)
    return replay_path(session_key)


def build_and_cache(session_key: str) -> Path:
    """Build a replay and write it to the cache. Returns the full payload path."""
    year, rnd, stype = parse_session_key(session_key)
    payload, huds = build_replay(year, rnd, stype)
    return write_replay_cache(session_key, payload, huds)


# ── Helpers ────────────────────────────────────────────────────────────

def _seconds(series: pd.Series) -> np.ndarray:
    return series.dt.total_seconds().to_numpy(dtype=float)


def _seconds_or_none(value) -> float | None:
    if value is None or pd.isna(value):
        return None
    return round(float(value.total_seconds()), 3)


def _round(v, nd: int = 3):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if np.isfinite(f) else None


def _clean(v):
    """JSON-safe scalar: NaN/NaT/pd.NA become None, numpy scalars become Python ones."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, np.generic):
        return v.item()
    return v


def _metres(pos: pd.DataFrame, rotation: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """FastF1 1/10 m → rotated metres."""
    x, y = rm.rotate_xy(pos["X"].to_numpy(float) / 10, pos["Y"].to_numpy(float) / 10, rotation)
    return x, y, pos["Z"].to_numpy(float) / 10


def _circuit(session) -> tuple[float, list[dict]]:
    """
    Track rotation and corners. ``get_circuit_info`` calls the MultiViewer API and fails when
    offline, so (like ``fetch_circuit_info`` in ingest.py) fall back to an unrotated map.
    """
    try:
        info = session.get_circuit_info()
    except Exception as exc:
        logger.warning("Circuit info unavailable, drawing unrotated: %s", exc)
        return 0.0, []
    if info is None:
        return 0.0, []

    rotation = float(info.rotation or 0.0)
    corners = []
    for _, c in info.corners.iterrows():
        cx, cy = float(c["X"]) / 10, float(c["Y"]) / 10
        a = np.deg2rad(float(c["Angle"]))
        lx = cx + CORNER_LABEL_OFFSET_M * np.cos(a)
        ly = cy + CORNER_LABEL_OFFSET_M * np.sin(a)
        (px,), (py,) = rm.rotate_xy([cx], [cy], rotation)
        (qx,), (qy,) = rm.rotate_xy([lx], [ly], rotation)
        letter = c.get("Letter")
        corners.append({
            "number": int(c["Number"]),
            "letter": "" if letter is None or pd.isna(letter) else str(letter),
            "x": round(float(px), 1),
            "y": round(float(py), 1),
            "label_x": round(float(qx), 1),
            "label_y": round(float(qy), 1),
        })
    return rotation, corners


def _reference_lap(session, rotation: float) -> rm.Reference:
    """
    Projection reference: the fastest lap's position trace, falling back to any clean lap.
    A lap with fewer than 100 position samples is treated as broken.
    """
    laps = session.laps
    candidates = []
    fastest = laps.pick_fastest()
    if fastest is not None and not (isinstance(fastest, pd.Series) and fastest.empty):
        candidates.append(fastest)
    clean = laps[(~laps["FastF1Generated"]) & laps["PitInTime"].isna() & laps["PitOutTime"].isna()]
    clean = clean[clean["LapNumber"] > 1].sort_values("LapTime")
    candidates.extend(row for _, row in clean.head(10).iterrows())

    for lap in candidates:
        try:
            pos = laps.loc[[lap.name]].iloc[0].get_pos_data()
        except Exception:
            continue
        pos = pos[~((pos["X"] == 0) & (pos["Y"] == 0))]
        if len(pos) < 100:
            continue
        x, y, z = _metres(pos, rotation)
        return rm.build_reference(x, y, z, step=1.0)
    raise ReplayUnavailable("No lap with usable position data to build a track reference")


def _real_lap_ends(drv_laps: pd.DataFrame) -> list[tuple[int, float]]:
    """``(lap_number, end_time)`` for laps FastF1 did not invent."""
    real = drv_laps[(~drv_laps["FastF1Generated"]) & drv_laps["Time"].notna()]
    return [(int(n), float(t.total_seconds())) for n, t in zip(real["LapNumber"], real["Time"])]


def _status_time(session, status: str) -> float | None:
    ss = getattr(session, "session_status", None)
    if ss is None or ss.empty:
        return None
    rows = ss[ss["Status"] == status]
    if rows.empty:
        return None
    return float(rows["Time"].iloc[0].total_seconds())


def _race_control(session, t0_date, t_start: float, t_end: float) -> list[dict]:
    """Race control messages on the session clock. Loading can fail silently; tolerate it."""
    try:
        rc = session.race_control_messages
    except Exception as exc:
        logger.warning("Race control messages unavailable: %s", exc)
        return []
    if rc is None or rc.empty:
        return []

    out = []
    for _, m in rc.iterrows():
        t = (m["Time"] - t0_date).total_seconds()
        if not (t_start <= t <= t_end):
            continue
        out.append({
            "t": round(t, 1),
            "category": _clean(m.get("Category")),
            "message": _clean(m.get("Message")),
            "flag": _clean(m.get("Flag")),
            "scope": _clean(m.get("Scope")),
            "sector": _clean(m.get("Sector")),
            "driver_number": _clean(m.get("RacingNumber")),
            "lap": _clean(m.get("Lap")),
        })
    return out


# ── Build ──────────────────────────────────────────────────────────────

def build_replay(year: int, round_number: int, session_type: str) -> tuple[dict, dict[str, dict]]:
    """
    Build ``(payload, huds)`` for one race or sprint.

    ``huds`` maps car number → focused-driver telemetry on the same grid.
    """
    if not is_race_session(year, session_type):
        raise ReplayUnavailable("Replay is only available for races and sprints")

    _init_fastf1()
    session = fastf1.get_session(year, round_number, session_type)
    session.load(laps=True, telemetry=True, weather=False, messages=True)
    session_key = _make_session_key(year, round_number, session_type)

    if not getattr(session, "pos_data", None):
        raise ReplayUnavailable("No position data for this session")

    race_start = float(session.session_start_time.total_seconds())
    finished_status_t = _status_time(session, "Finished")
    rotation, corners = _circuit(session)
    ref = _reference_lap(session, rotation)
    # Whole metres, so that ``d`` (sent as integers) is exactly ``n·L`` at every line crossing
    # and cars that finished on the same lap compare equal.
    L = float(round(ref.length))

    laps = session.laps
    results = session.results

    # ── Time window: grid before lights out → last car home ───────────
    lap_ends_by_drv: dict[str, list[tuple[int, float]]] = {}
    finish_by_drv: dict[str, float | None] = {}
    for num in session.drivers:
        lap_ends_by_drv[num] = _real_lap_ends(laps[laps["DriverNumber"] == num])
        finish_by_drv[num] = rm.detect_finish(lap_ends_by_drv[num], finished_status_t)

    finishes = [t for t in finish_by_drv.values() if t is not None]
    all_ends = [t for ends in lap_ends_by_drv.values() for _, t in ends]
    if not all_ends:
        raise ReplayUnavailable("No timed laps in this session")
    t_start = race_start - PRE_START_S
    t_end = (max(finishes) if finishes else max(all_ends)) + POST_FINISH_S
    grid = rm.make_grid(t_start, t_end, rm.REPLAY_HZ)
    n_frames = len(grid)

    # ── Per-driver position, progress and HUD ─────────────────────────
    drivers: list[dict] = []
    huds: dict[str, dict] = {}
    for num in session.drivers:
        pos = session.pos_data.get(num)
        if pos is None or pos.empty:
            logger.info("No position data for car %s, skipping", num)
            continue
        res = results.loc[num] if num in results.index else None
        abbr = str(res["Abbreviation"]) if res is not None else num
        team = str(res["TeamName"]) if res is not None else ""
        grid_pos = _clean(res["GridPosition"]) if res is not None else None

        x, y, z = _metres(pos, rotation)
        xyz, hidden = rm.resample_positions(_seconds(pos["SessionTime"]), x, y, z, grid)

        car = session.car_data.get(num)
        lap_ends = lap_ends_by_drv.get(num, [])
        finish_t = finish_by_drv.get(num)
        retired_t = None
        if finish_t is None:
            if car is not None and not car.empty:
                retired_t = rm.detect_retirement(_seconds(car["SessionTime"]), car["Speed"], race_start)
            else:
                retired_t = max((t for _, t in lap_ends), default=race_start)

        u = rm.unwrap_fraction(rm.project_fraction(ref, xyz))
        if finish_t is not None:
            finish_lap = max(n for n, t in lap_ends if t <= finish_t + 1e-6)
            d = rm.progress_from_laps(u, grid, lap_ends, race_start, L, finish_t, finish_lap * L)
        else:
            d = rm.progress_from_laps(u, grid, lap_ends, race_start, L, retired_t)

        drivers.append({
            "number": num,
            "abbr": abbr,
            "team": team,
            "grid": int(grid_pos) if grid_pos is not None else None,
            "classified": _clean(res["ClassifiedPosition"]) if res is not None else None,
            "status": _clean(res["Status"]) if res is not None else None,
            "finish_t": _round(finish_t),
            "retired_t": _round(retired_t),
            "x": rm.delta_encode(xyz[:, 0]),
            "y": rm.delta_encode(xyz[:, 1]),
            "d": rm.delta_encode(d),
            "hidden": rm.mask_to_ranges(hidden),
        })

        if car is not None and not car.empty:
            huds[num] = _build_hud(session_key, num, abbr, car, grid)

    # ── Timelines ─────────────────────────────────────────────────────
    ts = session.track_status
    track_status = rm.status_intervals(
        _seconds(ts["Time"]) if ts is not None and not ts.empty else [],
        ts["Status"] if ts is not None and not ts.empty else [],
        t_start,
        t_end,
    )
    for iv in track_status:
        iv["start_t"] = round(iv["start_t"], 3)
        iv["end_t"] = round(iv["end_t"], 3)
    reds = [(iv["start_t"], iv["end_t"]) for iv in track_status if iv["kind"] == "red"]

    abbr_of = {d["number"]: d["abbr"] for d in drivers}
    lap_rows: list[dict] = []
    pit_stops: list[dict] = []
    for num, drv_laps in laps.groupby("DriverNumber"):
        if num not in abbr_of:
            continue
        drv_laps = drv_laps.sort_values("LapNumber")
        for _, lap in drv_laps.iterrows():
            generated = bool(lap["FastF1Generated"])
            lap_rows.append({
                "driver": abbr_of[num],
                "lap": int(lap["LapNumber"]),
                "end_t": None if generated else _seconds_or_none(lap["Time"]),
                "lap_time": _seconds_or_none(lap["LapTime"]),
                "position": _clean(lap["Position"]),
                "compound": _clean(lap["Compound"]),
                "tyre_life": _clean(lap["TyreLife"]),
                "stint": _clean(lap["Stint"]),
            })
        stops = rm.pair_pit_stops(
            drv_laps["LapNumber"],
            _seconds(drv_laps["PitInTime"]),
            _seconds(drv_laps["PitOutTime"]),
            reds,
        )
        for stop in stops:
            stop["driver"] = abbr_of[num]
            stop["in_t"] = _round(stop["in_t"])
            stop["out_t"] = _round(stop["out_t"])
        pit_stops.extend(stops)
    pit_stops.sort(key=lambda s: s["in_t"])

    track = {
        "outline": _outline(ref),
        "rotation": rotation,
        "corners": corners,
    }
    t0_date = session.t0_date
    payload = {
        "version": REPLAY_VERSION,
        "encoding": "delta-int",
        "session_key": session_key,
        "event_name": str(session.event["EventName"]),
        "session_name": str(session.name),
        "hz": rm.REPLAY_HZ,
        "t_start": round(t_start, 3),
        "n_frames": n_frames,
        "race_start_t": round(race_start, 3),
        "finish_t": _round(min(finishes)) if finishes else None,
        "t0_date": t0_date.isoformat() if t0_date is not None else None,
        "total_laps": int(laps["LapNumber"].max()),
        "lap_length_m": round(L, 1),
        "track": track,
        "drivers": drivers,
        "laps": lap_rows,
        "pit_stops": pit_stops,
        "track_status": track_status,
        "race_control": _race_control(session, t0_date, t_start, t_end),
    }
    return payload, huds


def _outline(ref: rm.Reference) -> list[list[float]]:
    stride = max(1, int(round(OUTLINE_STEP_M / max(ref.length / len(ref.points), 1e-6))))
    pts = ref.points[::stride, :2]
    return [[round(float(x), 1), round(float(y), 1)] for x, y in pts]


def _build_hud(session_key: str, num: str, abbr: str, car: pd.DataFrame, grid: np.ndarray) -> dict:
    """Focused-driver telemetry resampled onto the replay grid."""
    t = _seconds(car["SessionTime"])
    drs_raw = rm.hold_resample(t, car["DRS"].to_numpy(dtype=float), grid)
    drs_open = np.isin(np.rint(drs_raw).astype(int), DRS_OPEN).astype(int)
    return {
        "version": REPLAY_VERSION,
        "encoding": "delta-int",
        "session_key": session_key,
        "number": num,
        "abbr": abbr,
        "speed": rm.delta_encode(rm.linear_resample(t, car["Speed"], grid)),
        "throttle": rm.delta_encode(np.clip(rm.linear_resample(t, car["Throttle"], grid), 0, 100)),
        "brake": rm.delta_encode(rm.hold_resample(t, car["Brake"].to_numpy(dtype=float), grid)),
        "gear": rm.delta_encode(rm.hold_resample(t, car["nGear"].to_numpy(dtype=float), grid)),
        "drs": rm.delta_encode(drs_open),
        "has_drs": bool(drs_open.any()),
    }


# ── Smoke run ──────────────────────────────────────────────────────────

def _smoke(year: int, rnd: int, stype: str) -> None:
    """Build, cache and print sanity checks against the official classification."""
    t = time.time()
    payload, huds = build_replay(year, rnd, stype)
    built = time.time() - t
    key = payload["session_key"]
    path = write_replay_cache(key, payload, huds)

    L = payload["lap_length_m"]
    grid = payload["t_start"] + np.arange(payload["n_frames"]) / payload["hz"]
    d = {drv["abbr"]: rm.delta_decode(drv["d"]) for drv in payload["drivers"]}
    info = {drv["abbr"]: drv for drv in payload["drivers"]}

    # Order at each official lap end vs the feed's Position.
    agree = total = 0
    for lap in payload["laps"]:
        if lap["end_t"] is None or lap["position"] is None:
            continue
        i = min(int(np.searchsorted(grid, lap["end_t"])), len(grid) - 1)
        running = [a for a in d if info[a]["retired_t"] is None or info[a]["retired_t"] > lap["end_t"]]
        rank = 1 + sum(d[a][i] > d[lap["driver"]][i] for a in running if a != lap["driver"])
        agree += abs(rank - lap["position"]) <= 1
        total += 1

    def final_key(a):
        drv = info[a]
        return (drv["finish_t"] is None, -d[a][-1], drv["finish_t"] or 0)

    order = sorted(d, key=final_key)
    official = sorted(info, key=lambda a: int(info[a]["classified"]) if str(info[a]["classified"]).isdigit() else 99)
    backsteps = sum(int((np.diff(v) < 0).sum()) for v in d.values())

    print(f"{key}: {payload['event_name']} — built in {built:.1f}s")
    print(f"  frames={payload['n_frames']} ({payload['n_frames'] / payload['hz'] / 60:.1f} min) "
          f"lap={L:.0f} m drivers={len(payload['drivers'])} laps={payload['total_laps']}")
    print(f"  replay={path.stat().st_size / 1e6:.2f} MB huds={len(huds)}")
    print(f"  lap-end order within ±1 of official: {agree}/{total} ({100 * agree / max(total, 1):.1f}%)")
    print(f"  backward steps in d: {backsteps}")
    print(f"  final order:    {' '.join(order[:12])}")
    print(f"  classification: {' '.join(official[:12])}")
    print(f"  pit stops={len(payload['pit_stops'])} (under red={sum(s['under_red'] for s in payload['pit_stops'])}) "
          f"track status={[iv['kind'] for iv in payload['track_status'] if iv['kind'] not in ('green', 'yellow')]} "
          f"race control={len(payload['race_control'])}")
    retired = [(a, round((info[a]['retired_t'] - payload['race_start_t']) / 60, 1))
               for a in info if info[a]['retired_t'] is not None]
    print(f"  retired (min after start): {retired}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("fastf1").setLevel(logging.WARNING)
    if len(sys.argv) != 4:
        print("usage: python -m backend.pipeline.replay YEAR ROUND SESSION_TYPE")
        sys.exit(2)
    _smoke(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3])
