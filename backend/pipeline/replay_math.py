"""
F1 Pitwall — Race Replay numerics

Pure NumPy/SciPy helpers behind :mod:`backend.pipeline.replay`. Nothing here imports FastF1,
so every function can be unit-tested against synthetic tracks.

Units throughout: time in session seconds, positions in metres (FastF1's 1/10 m divided by 10).

The central quantity is **race progress** ``d``: metres of race distance a car has covered,
with ``d = n·L`` exactly when it crosses the line to complete lap ``n``. Ordering, gaps and
intervals on the frontend are all derived from it. It is built by projecting each position
sample onto a reference lap (giving a lap fraction), unwrapping that into a continuous
"laps travelled" count ``u``, and then anchoring ``u`` to the official lap-end times. Anchoring
on lap *ends* (real line crossings) rather than lap starts matters because lap start times
overlap across red-flag stoppages.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

#: Playback grid rate. Matches FastF1's ~4.2 Hz position cadence, so no detail is invented.
REPLAY_HZ = 4

#: Track status codes from the F1 live timing feed, mapped to the names the frontend uses.
TRACK_STATUS_KINDS = {
    "1": "green",
    "2": "yellow",
    "4": "sc",
    "5": "red",
    "6": "vsc",
    "7": "vsc_ending",
}

#: A real position stream has gaps of up to ~1.4 s. Anything wider is a dropout, and the car
#: is hidden rather than drawn sliding in a straight line across the infield.
MAX_POSITION_GAP_S = 3.0

#: Speed (km/h) above which a car counts as still running, for retirement detection.
RUNNING_SPEED_KMH = 5.0


# ── Geometry ───────────────────────────────────────────────────────────

def rotate_xy(x, y, angle_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """
    Rotate points counter-clockwise by ``angle_deg``.

    Same convention as FastF1's circuit-map example (``xy @ [[c, s], [-s, c]]``), so applying
    ``circuit_info.rotation`` yields the orientation used on the official TV graphics.
    """
    a = np.deg2rad(angle_deg)
    c, s = np.cos(a), np.sin(a)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    return x * c - y * s, x * s + y * c


@dataclass(frozen=True)
class Reference:
    """A reference lap resampled at a fixed spacing, ready for nearest-point lookup."""

    points: np.ndarray  # (m, 3) x, y, z in metres
    frac: np.ndarray  # (m,) lap fraction in [0, 1) of each point
    length: float  # lap length in metres
    tree: cKDTree


def build_reference(x, y, z, step: float = 1.0) -> Reference:
    """
    Build a closed reference line from one lap's positions.

    The closing segment (last sample back to the first) is included in the lap length, since
    a lap's samples start and end a few metres either side of the line. The fraction origin is
    arbitrary: progress only ever uses *differences* in fraction, so it does not need to sit
    exactly on the timing line.

    Z is kept in the lookup tree so that crossovers (Suzuka) and the Yas Marina pit-exit tunnel
    project onto the correct level.
    """
    pts = np.column_stack([x, y, z]).astype(float)
    closed = np.vstack([pts, pts[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    length = float(s[-1])
    if length <= 0:
        raise ValueError("Reference lap has zero length")

    s_grid = np.arange(0.0, length, step)
    resampled = np.column_stack([np.interp(s_grid, s, closed[:, i]) for i in range(3)])
    return Reference(
        points=resampled,
        frac=s_grid / length,
        length=length,
        tree=cKDTree(resampled),
    )


def project_fraction(ref: Reference, xyz: np.ndarray) -> np.ndarray:
    """Lap fraction of the nearest reference point for each row of ``xyz``."""
    _, idx = ref.tree.query(xyz)
    return ref.frac[idx]


def unwrap_fraction(frac: np.ndarray) -> np.ndarray:
    """Turn a wrapping lap fraction into a continuous count of laps travelled."""
    return np.unwrap(2 * np.pi * np.asarray(frac, dtype=float)) / (2 * np.pi)


# ── Resampling ─────────────────────────────────────────────────────────

def make_grid(t_start: float, t_end: float, hz: int = REPLAY_HZ) -> np.ndarray:
    """Uniform playback grid, so frame ``i`` is at ``t_start + i / hz``."""
    n = int(np.floor((t_end - t_start) * hz)) + 1
    return t_start + np.arange(n) / hz


def _strictly_increasing(t: np.ndarray, *cols: np.ndarray):
    """Drop samples whose timestamp does not advance; ``np.interp`` requires increasing x."""
    keep = np.concatenate([[True], np.diff(t) > 0])
    return (t[keep], *(c[keep] for c in cols))


def resample_positions(t, x, y, z, grid, max_gap: float = MAX_POSITION_GAP_S):
    """
    Linearly resample one car's position stream onto ``grid``.

    FastF1 pads a short stream with ``X == Y == 0`` samples (2023 AUS: one running car had a
    36 s run of them), which would teleport the car to the origin. Those are dropped first.

    Returns ``(xyz, hidden)``: ``xyz`` is ``(len(grid), 3)``; ``hidden`` marks frames outside
    the data or inside a gap wider than ``max_gap``.
    """
    t = np.asarray(t, dtype=float)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    z = np.asarray(z, dtype=float)
    valid = np.isfinite(t) & np.isfinite(x) & np.isfinite(y) & ~((x == 0) & (y == 0))
    t, x, y, z = _strictly_increasing(t[valid], x[valid], y[valid], np.nan_to_num(z[valid]))

    grid = np.asarray(grid, dtype=float)
    if len(t) < 2:
        return np.zeros((len(grid), 3)), np.ones(len(grid), dtype=bool)

    xyz = np.column_stack([np.interp(grid, t, c) for c in (x, y, z)])

    after = np.clip(np.searchsorted(t, grid, side="left"), 0, len(t) - 1)
    before = np.clip(after - 1, 0, len(t) - 1)
    exact = t[after] == grid
    gap = np.where(exact, 0.0, t[after] - t[before])
    hidden = (grid < t[0]) | (grid > t[-1]) | (gap > max_gap)
    return xyz, hidden


def hold_resample(t, v, grid) -> np.ndarray:
    """Sample-and-hold resampling, for discrete channels (gear, brake, DRS)."""
    t = np.asarray(t, dtype=float)
    v = np.asarray(v)
    t, v = _strictly_increasing(t, v)
    if len(t) == 0:
        return np.zeros(len(grid), dtype=v.dtype)
    idx = np.clip(np.searchsorted(t, grid, side="right") - 1, 0, len(t) - 1)
    return v[idx]


def linear_resample(t, v, grid) -> np.ndarray:
    """Linear resampling for continuous channels (speed, throttle)."""
    t = np.asarray(t, dtype=float)
    v = np.asarray(v, dtype=float)
    t, v = _strictly_increasing(t, v)
    if len(t) == 0:
        return np.zeros(len(grid))
    return np.interp(grid, t, v)


def mask_to_ranges(mask: np.ndarray) -> list[list[int]]:
    """Run-length encode a boolean mask as ``[[start, end), ...]`` frame ranges."""
    m = np.asarray(mask, dtype=bool).astype(np.int8)
    edges = np.diff(np.concatenate([[0], m, [0]]))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [[int(a), int(b)] for a, b in zip(starts, ends)]


def delta_encode(values) -> list[int]:
    """
    Integer delta encoding: ``[v0, v1 - v0, v2 - v1, ...]``.

    A stationary car becomes a run of zeros, which gzip collapses; this halves the replay
    payload compared with absolute values.
    """
    a = np.rint(np.asarray(values, dtype=float)).astype(np.int64)
    if len(a) == 0:
        return []
    return np.concatenate([a[:1], np.diff(a)]).tolist()


def delta_decode(values) -> np.ndarray:
    """Inverse of :func:`delta_encode` (the frontend has its own copy in ``replay/decode.ts``)."""
    return np.cumsum(np.asarray(values, dtype=np.int64))


# ── Race progress ──────────────────────────────────────────────────────

#: A lap whose projected travel exceeds the expected count by more than this contains an extra
#: physical lap (a formation lap after a standing restart).
_EXTRA_LAP_THRESHOLD = 0.5
#: A lap whose projected travel falls short by more than this is a bad projection.
_SHORT_LAP_TOLERANCE = 0.3
#: Grid slots sit behind the timing line, so lap 1 legitimately starts at a small negative d.
_MAX_GRID_OFFSET_FRACTION = 0.25


def progress_from_laps(
    u: np.ndarray,
    grid: np.ndarray,
    lap_ends: list[tuple[int, float]],
    race_start: float,
    length: float,
    freeze_t: float | None = None,
    freeze_d: float | None = None,
) -> np.ndarray:
    """
    Race progress ``d`` (metres) per frame from unwrapped lap fraction ``u``.

    ``lap_ends`` holds ``(lap_number, session_time)`` for real line crossings only: FastF1's
    generated laps carry invented end times and must be excluded by the caller. Gaps in the
    lap numbers (a missing lap in the feed) are bridged.

    For each segment between anchors ``(p, t_p)`` and ``(n, E)``:

    * normal case: ``d(t) = n·L - (u(E) - u(t))·L``, which is exact at the line crossing;
    * travel exceeds the expected laps by > 0.5 (formation lap inside the segment): the same,
      clamped so ``d`` never drops below ``p·L``;
    * travel falls short by > 0.3 (projection failure): linear in time from ``p·L`` to ``n·L``.

    After the final anchor the car is extrapolated, capped below the next line crossing. From
    ``freeze_t`` (finish or retirement) ``d`` is held, at ``freeze_d`` when given: a finisher is
    pinned to exactly ``laps·L`` so that cars on the same lap tie and order by finish time. A
    running maximum removes the small backward steps that projection noise leaves behind.
    """
    u = np.asarray(u, dtype=float)
    grid = np.asarray(grid, dtype=float)
    d = np.empty(len(grid))

    if not lap_ends:
        d[:] = (u - np.interp(race_start, grid, u)) * length
        d = np.minimum(d, length * 0.999)
        return _freeze_and_monotone(d, grid, freeze_t, freeze_d)

    anchors = [(0, race_start)] + sorted(lap_ends, key=lambda a: a[1])
    u_at = np.interp([t for _, t in anchors], grid, u)

    seg_start = 0
    for k in range(1, len(anchors)):
        p, t_p = anchors[k - 1]
        n, t_e = anchors[k]
        expected = n - p
        seg_end = int(np.searchsorted(grid, t_e, side="right"))
        sl = slice(seg_start, seg_end)

        travel = u_at[k] - u_at[k - 1]
        if travel < expected - _SHORT_LAP_TOLERANCE:
            span = max(t_e - t_p, 1e-6)
            frac = np.clip((grid[sl] - t_p) / span, 0.0, 1.0)
            d[sl] = (p + frac * expected) * length
        else:
            d[sl] = (n - (u_at[k] - u[sl])) * length
            if p == 0 and travel - expected <= _EXTRA_LAP_THRESHOLD:
                lower = -_MAX_GRID_OFFSET_FRACTION * length
            else:
                lower = p * length
            d[sl] = np.clip(d[sl], lower, n * length)
        seg_start = seg_end

    last_n = anchors[-1][0]
    if seg_start < len(grid):
        tail = slice(seg_start, len(grid))
        d[tail] = last_n * length + (u[tail] - u_at[-1]) * length
        d[tail] = np.clip(d[tail], last_n * length, (last_n + 0.999) * length)

    return _freeze_and_monotone(d, grid, freeze_t, freeze_d)


def _freeze_and_monotone(
    d: np.ndarray, grid: np.ndarray, freeze_t: float | None, freeze_d: float | None
) -> np.ndarray:
    d = np.maximum.accumulate(d)
    if freeze_t is not None:
        i = int(np.searchsorted(grid, freeze_t, side="left"))
        if i < len(d):
            held = freeze_d if freeze_d is not None else (d[i - 1] if i > 0 else d[0])
            d[i:] = held
            d[:i] = np.minimum(d[:i], held)
    return d


# ── Race events ────────────────────────────────────────────────────────

def detect_finish(lap_ends: list[tuple[int, float]], finished_t: float | None) -> float | None:
    """
    When the car took the chequered flag: its first real line crossing at or after the
    session's ``'Finished'`` status (less 2 s of feed jitter). ``None`` if it never did.

    Result status strings are not used because their vocabulary changed in 2024
    ("+1 Lap" became "Lapped").
    """
    if finished_t is None:
        return None
    for _, t in sorted(lap_ends, key=lambda a: a[1]):
        if t >= finished_t - 2.0:
            return float(t)
    return None


def detect_retirement(t, speed, race_start: float) -> float | None:
    """
    Last moment after the start that the car was moving under its own power.

    Position data is useless for this: retired cars keep reporting positions, presumably from
    the recovery vehicle. Wheel speed drops to zero.
    """
    t = np.asarray(t, dtype=float)
    speed = np.asarray(speed, dtype=float)
    moving = (t >= race_start) & (speed > RUNNING_SPEED_KMH)
    if not moving.any():
        return float(race_start)
    return float(t[moving].max())


def status_intervals(times, codes, t0: float, t1: float) -> list[dict]:
    """
    Convert track status change events into ``[{start_t, end_t, code, kind}]`` clipped to
    ``[t0, t1]``. Consecutive identical codes merge; the final interval runs to ``t1``.
    """
    events = sorted(
        ((float(t), str(c)) for t, c in zip(times, codes) if t is not None and np.isfinite(t)),
        key=lambda e: e[0],
    )
    if not events:
        return [{"start_t": t0, "end_t": t1, "code": "1", "kind": "green"}]

    out: list[dict] = []
    current = "1"
    for t, code in events:
        if t <= t0:
            current = code
            continue
        if t >= t1:
            break
        if code == current:
            continue
        start = out[-1]["end_t"] if out else t0
        out.append({"start_t": start, "end_t": t, "code": current})
        current = code
    out.append({"start_t": out[-1]["end_t"] if out else t0, "end_t": t1, "code": current})

    merged: list[dict] = []
    for iv in out:
        if iv["end_t"] <= iv["start_t"]:
            continue
        if merged and merged[-1]["code"] == iv["code"]:
            merged[-1]["end_t"] = iv["end_t"]
        else:
            merged.append(dict(iv))
    for iv in merged:
        iv["kind"] = TRACK_STATUS_KINDS.get(iv["code"], "green")
    return merged


def pair_pit_stops(
    lap_numbers,
    pit_in,
    pit_out,
    red_intervals: list[tuple[float, float]] = (),
) -> list[dict]:
    """
    Pair a pit entry on lap ``n`` with the exit recorded on lap ``n + 1``.

    * A lap-1 ``PitOutTime`` with no preceding entry is a pit-lane start, not a stop.
    * Entries with no exit (retired in the pits) are kept with ``out_t = None``.
    * Negative durations (seen in the feed) are dropped.
    * A stop overlapping a red flag is flagged ``under_red``: its "duration" is the stoppage.
    """
    laps = [int(n) for n in lap_numbers]
    ins = {n: _finite_or_none(v) for n, v in zip(laps, pit_in)}
    outs = {n: _finite_or_none(v) for n, v in zip(laps, pit_out)}

    stops: list[dict] = []
    for n in sorted(laps):
        t_in = ins.get(n)
        if t_in is None:
            continue
        t_out = outs.get(n + 1)
        if t_out is not None and t_out < t_in:
            continue
        end = t_out if t_out is not None else t_in
        under_red = any(a < end and t_in < b for a, b in red_intervals) if t_out is not None else False
        stops.append({
            "lap": n,
            "in_t": t_in,
            "out_t": t_out,
            "duration": None if t_out is None else round(t_out - t_in, 3),
            "under_red": bool(under_red),
        })
    return stops


def _finite_or_none(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if np.isfinite(f) else None
