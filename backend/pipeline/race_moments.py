"""
F1 Pitwall — Race Moments

The story of a race in about ten lines — the start, lead changes, safety cars and their cause,
retirements, decisive podium passes, the fastest lap and the winning margin — each tied to a lap
so the dashboard can open the race replay at that moment.

Computed only from the ingested ``laps`` and ``results`` tables (no FastF1, no replay build), so
it is instant. The rules were tuned against every ingested race and sprint; the comments record
why each one is shaped the way it is, because lap-level timing data is full of traps:

* **Lap numbers follow the leader.** Cars further back are still on lap n−1 when a safety car
  comes out on lap n, so a lap's status is read from the leader's own lap.
* **A pit flag is not always a pit stop.** Under a red flag every car is flagged into the pits,
  and when the safety car leads the field through the pit lane everyone gets an in/out lap on the
  same tyres. Only a tyre change counts.
* **Most raw lead changes are pit-stop noise.** A car that leads only because the leader pitted
  first is not shown unless it keeps the lead once it has stopped too.
* **Positions on red-flag laps (and the lap after) are meaningless**, so those laps are skipped.
* **``results.gap_to_leader`` is stale in older ingests** (``'+-5482.285'``); the winning margin
  comes from P2's ``time``, which already holds the gap.

Run directly against the ingested Parquet files to print a race's moments::

    python -m backend.pipeline.race_moments 2023_03_R
"""

from __future__ import annotations

import sys
from collections import Counter
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

#: Moments shown per session; sprints are shorter, so fewer.
MAX_MOMENTS_RACE = 10
MAX_MOMENTS_SPRINT = 6

#: Track status codes from the timing feed (see ``replay_math.TRACK_STATUS_KINDS``). ``'7'``
#: (VSC ending) on its own is deliberately absent: a lap with only ``'7'`` is mostly green.
_STATUS_CODES = (("5", "red"), ("4", "sc"), ("6", "vsc"))
_PERIOD_NAMES = {"sc": "Safety car", "vsc": "VSC", "red": "Red flag"}
_PERIOD_PRIORITY = {"red": 1, "sc": 2, "vsc": 3}

#: Start movers worth mentioning, and the threshold above which they outrank other moments.
_START_MOVE_MIN = 3
_START_MOVE_BIG = 5
#: A top-10 car losing this many places in one green lap is an incident worth a line.
_DROP_MIN = 4
_DROP_CHAOS = 3  # …unless this many cars did (rain, a multi-car tangle): then none are notable.
_MAX_DROPS = 2
#: A retirement is a moment only for a car running in the points.
_RETIREMENT_MAX_POS = 10
#: Laps where this share of cars is pit-flagged are pit-lane shuffles, not racing.
_MASS_PIT_SHARE = 0.5
_SC_PIT_LANE_SHARE = 0.75
#: Sessions with more than this share of laps lacking a track status get a caveat.
_MISSING_STATUS_SHARE = 0.2


# ── Inputs ─────────────────────────────────────────────────────────────

def _clean_str(series: pd.Series) -> pd.Series:
    out = series.astype("object").where(series.notna(), "").astype(str).str.strip()
    return out.where(~out.isin(["nan", "None", "NaN", "<NA>"]), "")


@dataclass
class _Race:
    """Lap-by-driver lookup tables, built once from the raw rows."""

    laps: pd.DataFrame
    results: pd.DataFrame
    n_laps: int
    drivers: list[str]
    pos: pd.DataFrame  # lap × driver, float (NaN when unknown)
    status: pd.DataFrame  # lap × driver, str ('' when unknown)
    pit_in: pd.DataFrame  # lap × driver, bool
    pit_out: pd.DataFrame
    compound: pd.DataFrame
    tyre_life: pd.DataFrame
    present: pd.DataFrame  # lap × driver, bool: the driver has a row for this lap
    last_lap: dict[str, int]
    teams: dict[str, str]
    leaders: list[str | None] = field(default_factory=list)  # index n-1 → leader of lap n
    kinds: list[str] = field(default_factory=list)  # index n-1 → green/sc/vsc/red

    def leader(self, n: int) -> str | None:
        return self.leaders[n - 1] if 1 <= n <= self.n_laps else None

    def kind(self, n: int) -> str:
        return self.kinds[n - 1] if 1 <= n <= self.n_laps else "green"

    def is_red(self, n: int) -> bool:
        return self.kind(n) == "red"

    def position(self, driver: str, n: int) -> float:
        if n < 1 or n > self.n_laps or driver not in self.pos.columns:
            return np.nan
        return self.pos.at[n, driver]

    def pitted(self, driver: str, n: int) -> bool:
        if n < 1 or n > self.n_laps:
            return False
        return bool(self.pit_in.at[n, driver] or self.pit_out.at[n, driver])


def _prepare(laps: pd.DataFrame, results: pd.DataFrame) -> _Race:
    laps = laps.copy()
    laps["lap_number"] = pd.to_numeric(laps["lap_number"], errors="coerce")
    laps = laps[laps["lap_number"].notna()]
    laps["lap_number"] = laps["lap_number"].astype(int)
    laps["position"] = pd.to_numeric(laps["position"], errors="coerce")
    laps["track_status"] = _clean_str(laps["track_status"])
    laps["compound"] = _clean_str(laps["compound"])
    laps["tyre_life"] = pd.to_numeric(laps["tyre_life"], errors="coerce")
    for col in ("is_pit_in_lap", "is_pit_out_lap"):
        laps[col] = laps[col].astype("boolean").fillna(False).astype(bool)
    laps["_present"] = True

    n_laps = int(laps["lap_number"].max())
    index = pd.RangeIndex(1, n_laps + 1)

    drivers = sorted(laps["driver"].unique().tolist())

    def pivot(col: str, fill=None) -> pd.DataFrame:
        """Lap × driver table of one column; missing cells get ``fill`` (NaN when None)."""
        table = laps.pivot_table(
            index="lap_number", columns="driver", values=col, aggfunc="first", fill_value=fill, dropna=False
        )
        return table.reindex(index=index, columns=drivers, fill_value=fill if fill is not None else np.nan)

    present = pivot("_present", False).astype(bool)
    teams = laps.groupby("driver")["team"].first().dropna().to_dict()

    results = results.copy() if results is not None else pd.DataFrame()
    for col in ("driver", "team", "position", "grid_position", "status", "time"):
        if col not in results.columns:
            results[col] = None
    results["position"] = pd.to_numeric(results["position"], errors="coerce")
    results["grid_position"] = pd.to_numeric(results["grid_position"], errors="coerce")
    results["time"] = pd.to_numeric(results["time"], errors="coerce")
    results["status"] = _clean_str(results["status"])
    for _, row in results.iterrows():
        if row["team"] and row["driver"] not in teams:
            teams[row["driver"]] = row["team"]

    race = _Race(
        laps=laps,
        results=results,
        n_laps=n_laps,
        drivers=drivers,
        pos=pivot("position").astype(float),
        status=pivot("track_status", "").astype(str),
        pit_in=pivot("is_pit_in_lap", False).astype(bool),
        pit_out=pivot("is_pit_out_lap", False).astype(bool),
        compound=pivot("compound", "").astype(str),
        tyre_life=pivot("tyre_life").astype(float),
        present=present,
        last_lap=laps.groupby("driver")["lap_number"].max().astype(int).to_dict(),
        teams={k: str(v) for k, v in teams.items()},
    )
    race.leaders = _leaders(race)
    race.kinds = [_lap_kind(race, n) for n in range(1, n_laps + 1)]
    return race


# ── Lap-level classification ───────────────────────────────────────────

def status_kind(track_status: str) -> str:
    """Kind of a single lap's status string: red > safety car > VSC > green."""
    for code, kind in _STATUS_CODES:
        if code in track_status:
            return kind
    return "green"


def _leaders(race: _Race) -> list[str | None]:
    """Driver in P1 at the end of each lap, carried forward over laps with no P1 recorded."""
    out: list[str | None] = []
    current = None
    for n in range(1, race.n_laps + 1):
        row = race.pos.loc[n]
        p1 = row.index[row == 1].tolist()
        if p1:
            current = p1[0]
        out.append(current)
    return out


def _lap_kind(race: _Race, n: int) -> str:
    """
    The leader's own status for lap n, falling back to a majority of the field (≥50% of
    non-empty statuses) when the leader's is missing. A plain majority would run a lap early.
    """
    leader = race.leader(n)
    ts = race.status.at[n, leader] if leader is not None else ""
    if ts:
        return status_kind(ts)
    values = [v for v in race.status.loc[n].tolist() if v]
    if not values:
        return "green"
    for code, kind in _STATUS_CODES:
        if sum(code in v for v in values) / len(values) >= 0.5:
            return kind
    return "green"


def track_periods(race: _Race) -> list[dict]:
    """Runs of consecutive laps under the same non-green status."""
    periods: list[dict] = []
    for n in range(1, race.n_laps + 1):
        kind = race.kind(n)
        if kind == "green":
            continue
        if periods and periods[-1]["kind"] == kind and periods[-1]["end_lap"] == n - 1:
            periods[-1]["end_lap"] = n
        else:
            periods.append({"kind": kind, "start_lap": n, "end_lap": n})
    return periods


def _clean(race: _Race, n: int) -> bool:
    """Positions are trustworthy: neither this lap nor the previous one was under a red flag."""
    return not race.is_red(n) and not race.is_red(n - 1)


def _pit_share(race: _Race, n: int, frame: pd.DataFrame) -> float:
    running = race.present.loc[n]
    if not running.any():
        return 0.0
    return float(frame.loc[n][running].mean())


def _mass_pit_laps(race: _Race) -> set[int]:
    """Laps where most of the field is pit-flagged, plus the lap after each red flag lap."""
    flagged = race.pit_in | race.pit_out
    laps = {n for n in range(1, race.n_laps + 1) if _pit_share(race, n, flagged) >= _MASS_PIT_SHARE}
    laps |= {n + 1 for n in range(1, race.n_laps + 1) if race.is_red(n)}
    return laps


def real_stops(race: _Race) -> dict[str, list[int]]:
    """
    In-laps of genuine pit stops per driver.

    Excludes red-flag laps and safety-car pit-lane passes (an SC/VSC lap with ≥75% of the field
    flagged), and requires a tyre change: a new compound, or tyre life not continuing. 2018 data
    never updates tyres, so when fewer than half of the candidate stops show a change the tyre
    test is dropped.
    """
    candidates: list[tuple[str, int, bool]] = []
    for driver in race.drivers:
        for n in range(1, race.n_laps + 1):
            if not race.pit_in.at[n, driver] or race.is_red(n):
                continue
            if race.kind(n) in ("sc", "vsc") and _pit_share(race, n, race.pit_in) >= _SC_PIT_LANE_SHARE:
                continue
            candidates.append((driver, n, _tyres_changed(race, driver, n)))

    use_tyre_test = bool(candidates) and sum(c for _, _, c in candidates) / len(candidates) >= 0.5
    stops: dict[str, list[int]] = {d: [] for d in race.drivers}
    for driver, n, changed in candidates:
        if changed or not use_tyre_test:
            stops[driver].append(n)
    return stops


def _tyres_changed(race: _Race, driver: str, n: int) -> bool:
    if n >= race.n_laps or not race.present.at[n + 1, driver]:
        return True
    if race.compound.at[n + 1, driver] != race.compound.at[n, driver]:
        return True
    a, b = race.tyre_life.at[n, driver], race.tyre_life.at[n + 1, driver]
    if np.isnan(a) or np.isnan(b):
        return False
    return b != a + 1


def classify(status: str, has_laps: bool, last_lap: int, winner_laps: int) -> str:
    """
    ``finished`` / ``retired`` / ``dsq`` / ``dns`` from the results status.

    The vocabulary changed in 2024 ("+1 Lap" became "Lapped"; reasons became "Retired"), and a
    few sessions have no status at all, in which case completing 90% of the winner's laps counts
    as finishing.
    """
    s = status.strip()
    low = s.lower()
    if not has_laps or low in ("did not start", "withdrew") or low.startswith("illness"):
        return "dns"
    if low == "disqualified":
        return "dsq"
    if low in ("finished", "lapped") or s.startswith("+"):
        return "finished"
    if not s:
        return "retired" if last_lap < 0.9 * winner_laps else "finished"
    return "retired"


# ── Moments ────────────────────────────────────────────────────────────

@dataclass
class _Context:
    race: _Race
    stops: dict[str, list[int]]
    outcome: dict[str, str]
    final_pos: dict[str, float]
    grid: dict[str, float]
    mass_pit: set[int]

    def stops_by(self, driver: str, n: int) -> int:
        return sum(1 for k in self.stops.get(driver, []) if k <= n)

    def stops_after(self, driver: str, n: int) -> list[int]:
        return [k for k in self.stops.get(driver, []) if k > n]

    def stale(self, x: str, y: str, n: int) -> bool:
        """x is ahead of y only because y has stopped and x has not yet."""
        return self.stops_by(x, n - 1) < self.stops_by(y, n) and bool(self.stops_after(x, n - 1))

    def retiring(self, driver: str, n: int) -> bool:
        return self.outcome.get(driver) == "retired" and self.race.last_lap.get(driver, 0) <= n + 1


def _moment(lap: int, kind: str, text: str, driver: str | None, priority: int) -> dict:
    return {"lap": int(lap), "kind": kind, "text": text, "driver": driver, "priority": priority}


def finish_moment(ctx: _Context) -> tuple[dict, str | None, float | None, str | None]:
    """'X wins by 22.457s from Y', with the margin taken from P2's ``time``."""
    res = ctx.race.results.dropna(subset=["position"]).sort_values("position")
    winner = res.iloc[0]["driver"] if len(res) else ctx.race.leader(ctx.race.n_laps)
    runner_up, margin = None, None
    if len(res) > 1:
        p2 = res.iloc[1]
        runner_up = p2["driver"]
        if p2["status"] == "Finished" and pd.notna(p2["time"]) and 0 < p2["time"] < 600:
            margin = round(float(p2["time"]), 3)
    if margin is not None:
        text = f"{winner} wins by {margin:.3f}s from {runner_up}"
    else:
        text = f"{winner} wins"
    return _moment(ctx.race.n_laps, "finish", text, winner, 0), winner, margin, runner_up


def start_moments(ctx: _Context) -> list[dict]:
    race = ctx.race
    out: list[dict] = []
    leader1 = race.leader(1)
    pole = next((d for d, g in ctx.grid.items() if g == 1), None)
    if pole and leader1 and leader1 != pole:
        out.append(_moment(1, "start_lead", f"{leader1} takes the lead from {pole} at the start", leader1, 1))

    starters = int(race.present.loc[1].sum()) if race.n_laps else 0
    mass_pit_start = 1 in ctx.mass_pit
    moves: list[tuple[int, str, int, int]] = []
    for driver in race.drivers:
        grid = ctx.grid.get(driver)
        p1 = race.position(driver, 1)
        if grid is None or np.isnan(p1) or driver == leader1:
            continue
        if ctx.outcome.get(driver) == "retired" and race.last_lap.get(driver, 0) <= 1:
            continue
        if race.pit_in.at[1, driver] and not mass_pit_start:
            continue
        slot = int(grid) if grid > 0 else starters + 1
        moves.append((slot - int(p1), driver, slot, int(p1)))
    if not moves:
        return out

    def label(slot: int) -> str:
        return "the pit lane" if slot > starters else f"P{slot}"

    gain = max(moves, key=lambda m: (m[0], -m[2]))
    if gain[0] >= _START_MOVE_MIN:
        delta, driver, slot, p1 = gain
        out.append(_moment(
            1, "start_gain", f"{driver} gains {delta} places on lap 1 ({label(slot)} → P{p1})", driver,
            3 if delta >= _START_MOVE_BIG else 4,
        ))
    loss = min(moves, key=lambda m: (m[0], m[2]))
    if loss[0] <= -_START_MOVE_MIN:
        delta, driver, slot, p1 = loss
        out.append(_moment(
            1, "start_loss", f"{driver} loses {-delta} places on lap 1 ({label(slot)} → P{p1})", driver,
            3 if -delta >= _START_MOVE_BIG else 4,
        ))
    return out


def lead_changes(ctx: _Context) -> list[dict]:
    """
    Changes of race leader that a viewer would call a lead change.

    A car that leads only because the leader pitted first (``pit``) or because a red flag
    reshuffled the field (``restart``) is shown only if it is not already the "net" leader and
    either it is not running on an un-made stop or it is still leading two laps after making it.
    """
    race = ctx.race
    shown: list[dict] = []
    net = current = race.leader(1)
    last_checked = 1
    for n in range(2, race.n_laps + 1):
        if not _clean(race, n):
            continue
        red_skipped = any(race.is_red(k) for k in range(last_checked + 1, n))
        last_checked = n
        new = race.leader(n)
        if new is None or new == current:
            continue
        if race.pit_in.at[n, new]:
            continue  # a car on its in-lap can briefly rank P1 at the timing line
        if current is None:
            current = net = new
            continue

        if ctx.outcome.get(current) == "retired" and race.last_lap.get(current, 0) <= n + 1:
            reason = "ret"
        elif red_skipped:
            reason = "restart"
        elif race.pitted(current, n):
            reason = "pit"
        else:
            reason = "track"

        show = True
        if reason in ("pit", "restart"):
            show = new != net and (not ctx.stale(new, current, n) or _survives_stop(ctx, new, n))
        if show:
            shown.append({"lap": n, "reason": reason, "from": current, "to": new})
            net = new
        current = new
    return _merge_swaps(shown)


def _survives_stop(ctx: _Context, driver: str, n: int) -> bool:
    later = ctx.stops_after(driver, n - 1)
    if not later:
        return True
    return ctx.race.leader(later[0] + 2) == driver


def _merge_swaps(changes: list[dict]) -> list[dict]:
    """Three or more on-track swaps between the same pair, each within 3 laps, read as one duel."""
    out: list[dict] = []
    i = 0
    while i < len(changes):
        j = i
        if changes[i]["reason"] == "track":
            pair = {changes[i]["from"], changes[i]["to"]}
            while (
                j + 1 < len(changes)
                and changes[j + 1]["reason"] == "track"
                and {changes[j + 1]["from"], changes[j + 1]["to"]} == pair
                and changes[j + 1]["lap"] - changes[j]["lap"] <= 3
            ):
                j += 1
        group = changes[i : j + 1]
        if len(group) >= 3:
            a, b = group[0]["from"], group[0]["to"]
            first, last = group[0]["lap"], group[-1]["lap"]
            out.append(_moment(
                first, "lead_change", f"{a} and {b} swap the lead {len(group)} times (laps {first}–{last})",
                group[-1]["to"], 1,
            ))
        else:
            for c in group:
                text = {
                    "track": f"{c['to']} passes {c['from']} for the lead",
                    "ret": f"{c['to']} inherits the lead as {c['from']} retires",
                    "pit": f"{c['to']} takes the lead as {c['from']} pits",
                    "restart": f"{c['to']} leads at the restart",
                }[c["reason"]]
                out.append(_moment(c["lap"], "lead_change", text, c["to"], 1 if c["reason"] in ("track", "ret") else 2))
        i = j + 1
    return out


def incident_moments(ctx: _Context, periods: list[dict]) -> tuple[list[dict], set[str]]:
    """
    One moment per safety car / VSC / red flag, naming the retirement that caused it. Adjacent
    periods with no new cause fold together: "Safety car → Red flag (laps 7–8) — ALB out".
    """
    race = ctx.race
    retirees = [d for d, o in ctx.outcome.items() if o == "retired" and d in race.last_lap]
    incidents: list[dict] = []
    for period in periods:
        start = period["start_lap"]
        causes = []
        for driver in retirees:
            last = race.last_lap[driver]
            if not (start - 3 <= last <= start):
                continue
            ts = race.status.at[last, driver]
            if any(c in ts for c in "456") or ("2" in ts and not race.pit_in.at[last, driver]):
                causes.append(driver)
        causes.sort(key=lambda d: (race.last_lap[d], d))
        prev = incidents[-1] if incidents else None
        if prev and start == prev["end_lap"] + 1 and set(causes) <= set(prev["causes"]):
            prev["kinds"].append(period["kind"])
            prev["end_lap"] = period["end_lap"]
        else:
            incidents.append({
                "kinds": [period["kind"]], "start_lap": start, "end_lap": period["end_lap"], "causes": causes,
            })

    moments, named = [], set()
    for inc in incidents:
        names = " → ".join(_PERIOD_NAMES[k] for k in inc["kinds"])
        s, e = inc["start_lap"], inc["end_lap"]
        laps = f"lap {s}" if s == e else f"laps {s}–{e}"
        text = f"{names} ({laps})"
        if inc["causes"]:
            text += f" — {', '.join(inc['causes'])} out"
            named.update(inc["causes"])
        kind = min(inc["kinds"], key=lambda k: _PERIOD_PRIORITY[k])
        moments.append(_moment(s, kind, text, inc["causes"][0] if inc["causes"] else None, _PERIOD_PRIORITY[kind]))
    return moments, named


def retirement_moments(ctx: _Context, already_named: set[str]) -> list[dict]:
    race = ctx.race
    out = []
    for driver, outcome in ctx.outcome.items():
        if outcome != "retired" or driver in already_named or driver not in race.last_lap:
            continue
        last = race.last_lap[driver]
        pos = next(
            (race.position(driver, n) for n in range(last, 0, -1)
             if _clean(race, n) and not np.isnan(race.position(driver, n))),
            np.nan,
        )
        if np.isnan(pos) or pos > _RETIREMENT_MAX_POS:
            continue
        status = race.results.loc[race.results["driver"] == driver, "status"]
        reason = status.iloc[0] if len(status) else ""
        text = f"{driver} retires from P{int(pos)}"
        if reason and reason.lower() != "retired":
            text += f" ({reason})"
        out.append(_moment(last, "retirement", text, driver, 2 if pos <= 3 else 3))
    return out


def _eligible_for_passes(ctx: _Context, n: int) -> bool:
    race = ctx.race
    return (
        n >= 2
        and race.kind(n) == "green"
        and not race.is_red(n - 1)
        and n not in ctx.mass_pit
        and (n - 1) not in ctx.mass_pit
    )


def passes(ctx: _Context) -> tuple[int, list[dict]]:
    """
    On-track passes, counted for the stat; decisive passes for P2/P3 become moments.

    A pass is a pair that swapped order over a green lap with neither car pitting, where the
    passed car is not retiring and did not simply fall down the order (lost ≤2 places).
    It is shown only if the passer keeps that place for the rest of the race, finishes ahead,
    and the passed car was not merely running long on old tyres.
    """
    race = ctx.race
    count = 0
    moments: list[dict] = []
    for n in range(2, race.n_laps + 1):
        if not _eligible_for_passes(ctx, n):
            continue
        before = race.pos.loc[n - 1]
        after = race.pos.loc[n]
        cars = [d for d in race.drivers if not np.isnan(before[d]) and not np.isnan(after[d]) and not race.pitted(d, n)]
        shown_this_lap: set[str] = set()
        for a in cars:
            for b in cars:
                if a == b or not (before[a] > before[b] and after[a] < after[b]):
                    continue
                if ctx.retiring(b, n) or after[b] - before[b] > 2:
                    continue
                count += 1
                k = int(after[a])
                if k in (2, 3) and a not in shown_this_lap and _decisive(ctx, a, b, n, k):
                    moments.append(_moment(n, "podium_pass", f"{a} passes {b} for P{k}", a, 3))
                    shown_this_lap.add(a)
    return count, moments


def _decisive(ctx: _Context, a: str, b: str, n: int, k: int) -> bool:
    race = ctx.race
    if ctx.stale(b, a, n):
        return False
    later = race.pos.loc[n + 1 :, a].dropna()
    if (later > k).any():
        return False
    fa, fb = ctx.final_pos.get(a, np.nan), ctx.final_pos.get(b, np.nan)
    if np.isnan(fa):
        return False
    return np.isnan(fb) or fa < fb


def position_drops(ctx: _Context) -> list[dict]:
    race = ctx.race
    found: list[tuple[int, int, str, int, int]] = []
    for n in range(2, race.n_laps + 1):
        if not _eligible_for_passes(ctx, n):
            continue
        lap_drops = []
        for d in race.drivers:
            a, b = race.position(d, n - 1), race.position(d, n)
            if np.isnan(a) or np.isnan(b) or a > 10 or race.pitted(d, n) or ctx.retiring(d, n):
                continue
            if b - a >= _DROP_MIN:
                lap_drops.append((int(b - a), n, d, int(a), int(b)))
        if 0 < len(lap_drops) < _DROP_CHAOS:
            found.extend(lap_drops)
    found.sort(key=lambda x: (-x[0], x[1]))
    return [
        _moment(n, "position_drop", f"{d} drops from P{a} to P{b}", d, 4)
        for _, n, d, a, b in found[:_MAX_DROPS]
    ]


def fastest_lap(race: _Race) -> dict | None:
    timed = race.laps[pd.to_numeric(race.laps["lap_time"], errors="coerce") > 0]
    if timed.empty:
        return None
    row = timed.loc[pd.to_numeric(timed["lap_time"]).idxmin()]
    return {"driver": row["driver"], "lap": int(row["lap_number"]), "time": round(float(row["lap_time"]), 3)}


def biggest_mover(ctx: _Context) -> dict | None:
    """Largest grid-to-flag gain among finishers (a pit-lane start counts as last on the grid)."""
    best = None
    for driver, grid in ctx.grid.items():
        if driver not in ctx.final_pos or ctx.outcome.get(driver) != "finished":
            continue
        slot = int(grid) if grid > 0 else len(ctx.race.drivers) + 1
        finish = int(ctx.final_pos[driver])
        if best is None or (slot - finish, -finish) > (best["gain"], -best["finish"]):
            best = {"driver": driver, "grid": int(grid), "finish": finish, "gain": slot - finish}
    return best if best and best["gain"] > 0 else None


def _format_lap_time(seconds: float) -> str:
    m, s = divmod(seconds, 60)
    return f"{int(m)}:{s:06.3f}"


# ── Entry point ────────────────────────────────────────────────────────

def compute_race_moments(
    laps: pd.DataFrame,
    results: pd.DataFrame,
    session_type: str = "R",
    session_key: str | None = None,
) -> dict:
    """
    Summarise a race from its ``laps`` and ``results`` rows (as stored in DuckDB).

    Raises ``ValueError`` if there are no laps.
    """
    if laps is None or laps.empty:
        raise ValueError("No laps for this session")
    race = _prepare(laps, results)
    res = race.results

    winner_row = res.dropna(subset=["position"]).sort_values("position")
    winner_laps = race.last_lap.get(winner_row.iloc[0]["driver"], race.n_laps) if len(winner_row) else race.n_laps
    outcome = {
        d: classify(
            str(res.loc[res["driver"] == d, "status"].iloc[0]) if (res["driver"] == d).any() else "",
            d in race.last_lap,
            race.last_lap.get(d, 0),
            winner_laps,
        )
        for d in set(race.drivers) | set(res["driver"].dropna())
    }
    grid_known = res["grid_position"].notna().any()
    grid = {r["driver"]: float(r["grid_position"]) for _, r in res.iterrows() if pd.notna(r["grid_position"])}
    final_pos = {r["driver"]: float(r["position"]) for _, r in res.iterrows() if pd.notna(r["position"])}

    ctx = _Context(
        race=race,
        stops=real_stops(race),
        outcome=outcome,
        final_pos=final_pos,
        grid=grid,
        mass_pit=_mass_pit_laps(race),
    )

    periods = track_periods(race)
    finish, winner, margin, runner_up = finish_moment(ctx)
    leads = lead_changes(ctx)
    incidents, named = incident_moments(ctx, periods)
    pass_count, pass_moments = passes(ctx)
    fl = fastest_lap(race)

    candidates = [finish, *leads, *incidents, *retirement_moments(ctx, named), *pass_moments, *position_drops(ctx)]
    if grid_known:
        candidates.extend(start_moments(ctx))
    if fl:
        candidates.append(_moment(
            fl["lap"], "fastest_lap", f"Fastest lap: {fl['driver']} {_format_lap_time(fl['time'])}", fl["driver"], 5,
        ))

    cap = MAX_MOMENTS_SPRINT if session_type in ("S", "SQ") else MAX_MOMENTS_RACE
    kept = sorted(candidates, key=lambda m: (m["priority"], m["lap"]))[:cap]
    kept.sort(key=lambda m: (m["lap"], m["kind"] == "finish"))

    laps_led = Counter(d for d in race.leaders if d is not None)

    caveats = []
    status_missing = (race.laps["track_status"] == "").mean()
    if status_missing > _MISSING_STATUS_SHARE:
        caveats.append("Track status is missing for part of this race, so some safety cars may not show.")
    if not grid_known:
        caveats.append("Grid positions are missing, so moves at the start are not shown.")
    dsq = sorted(d for d, o in outcome.items() if o == "dsq")
    if dsq:
        caveats.append(f"Later disqualified: {', '.join(dsq)}.")

    return {
        "session_key": session_key,
        "total_laps": race.n_laps,
        "winner": {"driver": winner, "team": race.teams.get(winner)} if winner else None,
        "runner_up": runner_up,
        "margin_s": margin,
        "teams": race.teams,
        "leaders": race.leaders,
        "periods": periods,
        "moments": kept,
        "stats": {
            "lead_changes": sum(1 for m in leads if m["kind"] == "lead_change"),
            "laps_led": [{"driver": d, "laps": c} for d, c in laps_led.most_common(3)],
            "passes": pass_count,
            "dnfs": sum(1 for o in outcome.values() if o == "retired"),
            "safety_cars": sum(1 for p in periods if p["kind"] == "sc"),
            "vscs": sum(1 for p in periods if p["kind"] == "vsc"),
            "red_flags": sum(1 for p in periods if p["kind"] == "red"),
            "biggest_mover": biggest_mover(ctx) if grid_known else None,
            "fastest_lap": fl,
        },
        "caveats": caveats,
    }


if __name__ == "__main__":
    from backend.config import PARQUET_LAPS_DIR, PARQUET_RESULTS_DIR

    if len(sys.argv) != 2:
        print("usage: python -m backend.pipeline.race_moments SESSION_KEY")
        sys.exit(2)
    key = sys.argv[1]
    laps_df = pd.read_parquet(PARQUET_LAPS_DIR / f"{key}.parquet")
    results_path = PARQUET_RESULTS_DIR / f"{key}.parquet"
    results_df = pd.read_parquet(results_path) if results_path.exists() else pd.DataFrame()
    out = compute_race_moments(laps_df, results_df, key.rsplit("_", 1)[-1], key)
    for m in out["moments"]:
        print(f"  L{m['lap']:<3} {m['kind']:<14} {m['text']}")
    s = out["stats"]
    led = ", ".join(f"{x['driver']} {x['laps']}" for x in s["laps_led"])
    print(f"  stats: {s['lead_changes']} lead changes · led {led} · {s['passes']} passes · {s['dnfs']} DNF · "
          f"SC {s['safety_cars']} / VSC {s['vscs']} / red {s['red_flags']} · mover {s['biggest_mover']}")
    for c in out["caveats"]:
        print(f"  caveat: {c}")
