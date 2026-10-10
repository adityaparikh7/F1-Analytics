"""
F1 Pitwall — Championship Projection

Turns one season's ingested Race and Sprint results into the championship story: the points
each driver and constructor held after every round, who can still mathematically win, and
Monte Carlo odds of each of them doing so.

Pure functions over DataFrames and lists, with no database access, so every rule here can be
unit-tested against a hand-built season. ``backend/api/championship.py`` does the I/O.

The simulation is a *form* model, not a racing model, and is deliberately simple enough to
explain in one paragraph on the page:

    for every simulated season:
        each driver gets a pace drift that persists for the rest of that season
        for every remaining session:
            each driver draws one of their recent Grand Prix finishing positions (recent
            races weighted more), adds their drift and Gaussian noise, and may retire
            sorting those scores gives a valid finishing order, scored with the season's table

The three spread parameters were chosen by backtesting every round of the completed 2018–2025
seasons against the eventual champion — see :data:`CALIBRATION`.

Every simulated season consumes the same random draws whether or not the caller pins any
what-if results ("common random numbers"), so the difference between a baseline projection
and a what-if is caused by the pins alone, not by sampling noise.

What the model does not know about — upgrades, grid penalties, team orders, weather, the
fastest-lap bonus — is spelled out by :func:`describe_method` and shown alongside the odds.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ── Defaults ───────────────────────────────────────────────────────────

DEFAULT_N_SIMS = 10_000
DEFAULT_FORM_WINDOW = 10
#: Weight of a result relative to the one after it. 0.85 halves a result's influence about
#: every four races, so a mid-season swing in pace shows up within a few rounds without the
#: last race alone deciding everything.
DEFAULT_DECAY = 0.85
#: Gaussian noise added to each drawn position, in places, independently per session. Without
#: it a driver who won all of their recent races would win every simulated race.
DEFAULT_NOISE_SD = 1.5
#: Retirement chance applied to every driver in every simulated session, on top of any
#: retirements already present in their form, so a spotless recent record is not treated as
#: immunity.
DEFAULT_DNF_FLOOR = 0.05
#: Standard deviation, in places, of a pace offset drawn once per driver per simulated season
#: and applied to every remaining session. Race-to-race noise alone treats sessions as
#: independent, so the spread of a points total grows only with the square root of the races
#: left — but real seasons swing persistently (upgrades, a driver finding or losing form), and
#: without this term the backtest was overconfident: leaders given 80–95% odds won only 69% of
#: the time, and one given 99% lost. It is what turns 2025 from "Piastri certain" into the upset
#: it was.
DEFAULT_DRIFT_SD = 1.0
#: How the defaults above were chosen, shown on the page alongside the odds.
CALIBRATION = (
    "Spread parameters were tuned by replaying every round of the completed 2018–2025 seasons "
    "(146 projections) against the eventual champion. With them, leaders given 80–95% odds won "
    "91% of the time and leaders given 99% or more always did. Without the season-long pace "
    "drift, the 80–95% group won only 69% of the time."
)
#: Below this many Grand Prix results of their own, a driver's form is topped up with their
#: team-mate's — a mid-season replacement would otherwise rest on one or two races.
MIN_FORM_RESULTS = 3
#: Final-position probabilities are returned for this many places.
POSITION_PROBABILITY_DEPTH = 10

#: Team names the ingest pipeline writes when FastF1 had none. Mirrors the exclusions in
#: ``queries.get_constructor_standings``.
_NO_TEAM = {"", "None", "nan"}


# ── Points rules ───────────────────────────────────────────────────────

_RACE_POINTS: tuple[float, ...] = (25, 18, 15, 12, 10, 8, 6, 4, 2, 1)
_SPRINT_POINTS_2021: tuple[float, ...] = (3, 2, 1)
_SPRINT_POINTS: tuple[float, ...] = (8, 7, 6, 5, 4, 3, 2, 1)


@dataclass(frozen=True)
class PointsSystem:
    """One season's points rules."""

    race: tuple[float, ...]
    sprint: tuple[float, ...]
    #: Bonus for the fastest lap by a top-ten finisher (2019–2024). It counts towards who can
    #: still win, because it is a point a driver could genuinely score, but it is never
    #: awarded in simulation: the form model has no notion of who sets fastest laps.
    fastest_lap: float

    def table(self, session_type: str) -> tuple[float, ...]:
        return self.race if session_type == "R" else self.sprint

    def max_driver_points(self, session_type: str) -> float:
        """Most one driver can score in a session: a win, plus the fastest-lap bonus."""
        table = self.table(session_type)
        bonus = self.fastest_lap if session_type == "R" else 0.0
        return float(table[0] + bonus) if table else 0.0

    def max_team_points(self, session_type: str) -> float:
        """Most one team can score in a session: a one-two, plus the fastest-lap bonus."""
        table = self.table(session_type)
        bonus = self.fastest_lap if session_type == "R" else 0.0
        return float(sum(table[:2]) + bonus) if table else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {"race": list(self.race), "sprint": list(self.sprint), "fastest_lap": self.fastest_lap}


def points_system(year: int) -> PointsSystem:
    """
    The points rules in force in *year*, for every season the app supports (2018 on).

    Completed sessions are always scored from the published ``results.points``, so these
    tables only drive the simulation of remaining sessions and the maximum-points arithmetic
    behind "who can still win".
    """
    if year <= 2018:
        return PointsSystem(_RACE_POINTS, (), 0.0)
    if year <= 2020:
        return PointsSystem(_RACE_POINTS, (), 1.0)
    if year == 2021:
        return PointsSystem(_RACE_POINTS, _SPRINT_POINTS_2021, 1.0)
    if year <= 2024:
        return PointsSystem(_RACE_POINTS, _SPRINT_POINTS, 1.0)
    return PointsSystem(_RACE_POINTS, _SPRINT_POINTS, 0.0)


# ── Schedule ───────────────────────────────────────────────────────────


def _session_label(session_type: str) -> str:
    return "Sprint" if session_type == "S" else "Race"


@dataclass(frozen=True)
class ScoringSession:
    """One points-paying session: the Sprint or the Grand Prix of a round."""

    round_number: int
    session_type: str
    event_name: str

    @property
    def key(self) -> tuple[int, str]:
        return (self.round_number, self.session_type)

    @property
    def order(self) -> tuple[int, int]:
        """Chronological sort key. A Sprint runs before the Grand Prix of its weekend."""
        return (self.round_number, 0 if self.session_type == "S" else 1)

    def to_dict(self) -> dict[str, Any]:
        return {
            "round_number": self.round_number,
            "session_type": self.session_type,
            "event_name": self.event_name,
        }


@dataclass
class Schedule:
    """A season split at the as-of point into what has been scored and what is still to run."""

    as_of_round: int
    latest_round: int
    #: The last scored session at the as-of point. On a sprint weekend this can be the Sprint,
    #: with that round's Grand Prix still to run.
    as_of_session: ScoringSession
    completed: list[ScoringSession]
    remaining: list[ScoringSession]
    rounds: list[dict[str, Any]]
    has_calendar: bool
    #: True when some "remaining" sessions have in fact been run and ingested: the caller
    #: rewound the season to replay a projection against what really happened.
    is_backtest: bool
    warnings: list[str]

    @property
    def season_complete(self) -> bool:
        return self.has_calendar and not self.remaining


def build_schedule(
    year: int,
    calendar: Sequence[dict[str, Any]],
    results: pd.DataFrame,
    as_of_round: int | None = None,
) -> Schedule:
    """
    Expand the calendar into scoring sessions and split them at the as-of point.

    *results* is the season's Race/Sprint results (``queries.get_season_results``); a session
    counts as ingested when it has any result row. The as-of point defaults to the latest
    ingested round. Within that round the split is by session, not by round: with a Sprint
    ingested and its Grand Prix not, the Sprint is scored and the Grand Prix is simulated.

    A session before the as-of point that has no results is reported in ``warnings`` rather
    than simulated — it happened, it just was not ingested.

    Raises ValueError when there are no results, or *as_of_round* is outside the rounds that
    have them.
    """
    if results.empty:
        raise ValueError(f"No race or sprint results ingested for {year}")

    ingested = {
        (int(rnd), str(stype))
        for rnd, stype in results[["round_number", "session_type"]].drop_duplicates().itertuples(index=False)
    }
    ingested_rounds = sorted({rnd for rnd, _ in ingested})
    first_round, latest_round = ingested_rounds[0], ingested_rounds[-1]
    if as_of_round is None:
        as_of_round = latest_round
    elif not first_round <= as_of_round <= latest_round:
        raise ValueError(
            f"as_of_round must be between {first_round} and {latest_round} for {year}, got {as_of_round}"
        )

    events = [
        row
        for row in calendar
        if int(row.get("round_number") or 0) > 0 and str(row.get("event_format") or "").lower() != "testing"
    ]
    sessions: dict[tuple[int, str], ScoringSession] = {}
    for row in events:
        rnd, name = int(row["round_number"]), str(row["event_name"])
        if str(row.get("event_format") or "").lower().startswith("sprint"):
            sessions[(rnd, "S")] = ScoringSession(rnd, "S", name)
        sessions[(rnd, "R")] = ScoringSession(rnd, "R", name)

    # Results the calendar does not list still count — and without a calendar they are all
    # there is.
    names = results.groupby("round_number")["event_name"].first()
    for rnd, stype in ingested:
        sessions.setdefault((rnd, stype), ScoringSession(rnd, stype, str(names.get(rnd, f"Round {rnd}"))))

    ordered = sorted(sessions.values(), key=lambda s: s.order)
    # Non-empty: as_of_round is at least the first ingested round.
    completed = [s for s in ordered if s.key in ingested and s.round_number <= as_of_round]
    cutoff = completed[-1].order
    remaining = [s for s in ordered if s.order > cutoff]
    missing = [s for s in ordered if s.order < cutoff and s.key not in ingested]

    warnings: list[str] = []
    if not events:
        warnings.append(
            f"No calendar ingested for {year}: rounds after round {latest_round} are unknown, so they are "
            "not projected. Ingest the calendar to project the rest of the season."
        )
    for s in missing:
        warnings.append(
            f"Round {s.round_number} {s.event_name} ({_session_label(s.session_type)}) has no ingested "
            "results, so its points are missing from the standings."
        )

    rounds = []
    for rnd in sorted({s.round_number for s in ordered}):
        in_round = [s for s in ordered if s.round_number == rnd]
        rounds.append(
            {
                "round_number": rnd,
                "event_name": in_round[-1].event_name,
                "has_sprint": any(s.session_type == "S" for s in in_round),
                "completed": in_round[-1].order <= cutoff,
            }
        )

    return Schedule(
        as_of_round=as_of_round,
        latest_round=latest_round,
        as_of_session=completed[-1],
        completed=completed,
        remaining=remaining,
        rounds=rounds,
        has_calendar=bool(events),
        is_backtest=any(s.key in ingested for s in remaining),
        warnings=warnings,
    )


# ── Progression ────────────────────────────────────────────────────────


def _clean_team(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    text = str(value)
    return None if text in _NO_TEAM else text


def _with_wins(results: pd.DataFrame) -> pd.DataFrame:
    """Copy of *results* with numeric positions and a ``win`` flag for Grand Prix victories."""
    frame = results.copy()
    frame["round_number"] = frame["round_number"].astype(int)
    # Float, not DuckDB's nullable Int32: older seasons have unclassified rows with no
    # position, and comparisons against pd.NA propagate NA instead of returning False.
    frame["position"] = pd.to_numeric(frame["position"], errors="coerce").astype(float)
    frame["points"] = pd.to_numeric(frame["points"], errors="coerce").fillna(0.0)
    frame["win"] = ((frame["session_type"] == "R") & (frame["position"] == 1)).astype(int)
    return frame


def _has_team(frame: pd.DataFrame) -> pd.Series:
    return frame["team"].map(_clean_team).notna()


def _cumulative(frame: pd.DataFrame, key: str, rounds: list[int]) -> list[dict[str, Any]]:
    """Cumulative points, wins and position per *key* (driver or team) after each round."""
    if frame.empty:
        return []
    points = frame.pivot_table(index=key, columns="round_number", values="points", aggfunc="sum").reindex(
        columns=rounds
    )
    wins = frame.pivot_table(index=key, columns="round_number", values="win", aggfunc="sum").reindex(
        columns=rounds
    )
    appeared = points.notna().astype(int).cummax(axis=1).astype(bool)
    cum_points = points.fillna(0.0).cumsum(axis=1)
    cum_wins = wins.fillna(0).cumsum(axis=1)

    positions: dict[tuple[str, int], int] = {}
    for rnd in rounds:
        present = [k for k in points.index if appeared.at[k, rnd]]
        present.sort(key=lambda k: (-cum_points.at[k, rnd], -cum_wins.at[k, rnd], k))
        for pos, k in enumerate(present, start=1):
            positions[(k, rnd)] = pos

    final = rounds[-1]
    entries = [
        {
            key: str(k),
            "cumulative": [_r(cum_points.at[k, rnd], 1) if appeared.at[k, rnd] else None for rnd in rounds],
            "positions": [positions.get((k, rnd)) for rnd in rounds],
            "points": _r(cum_points.at[k, final], 1),
            "wins": int(cum_wins.at[k, final]),
        }
        for k in points.index
    ]
    entries.sort(key=lambda e: e["positions"][-1])
    return entries


def points_progression(results: pd.DataFrame) -> dict[str, Any]:
    """
    Cumulative points and championship position after every round that has results.

    Ordering matches the standings query in ``backend/db/queries.py`` — points, then Grand
    Prix wins — with the name as a final deterministic tie-break. A driver or team is ``None``
    for rounds before their first appearance, so a mid-season debut starts its line where it
    happened rather than at zero from round one.
    """
    frame = _with_wins(results)
    rounds = sorted(int(r) for r in frame["round_number"].unique())

    drivers = _cumulative(frame, "driver", rounds)
    latest_team = frame.sort_values("round_number").groupby("driver")["team"].last()
    for entry in drivers:
        entry["team"] = _clean_team(latest_team.get(entry["driver"]))

    constructors = _cumulative(frame[_has_team(frame)], "team", rounds)
    return {"round_numbers": rounds, "drivers": drivers, "constructors": constructors}


def season_progression(year: int, results: pd.DataFrame, calendar: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Payload for ``GET /championship/progression``."""
    schedule = build_schedule(year, calendar, results)
    return {
        "year": year,
        "latest_round": schedule.latest_round,
        "rounds": schedule.rounds,
        **points_progression(results),
        "warnings": schedule.warnings,
    }


# ── Form ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DriverForm:
    """The recent results a driver's simulated finishes are drawn from."""

    driver: str
    team: str | None
    #: Finishing positions, most recent first. Retirements are included at the position the
    #: driver was classified in, which is how a habit of retiring shows up in the odds.
    positions: np.ndarray
    #: Unnormalised recency weights, aligned with ``positions``.
    weights: np.ndarray
    n_own: int
    #: ``"own"``; ``"pooled"`` when topped up with the team-mate's results; ``"field"`` when
    #: topped up with the field median because the team-mate had none either.
    source: str


def driver_form(
    results: pd.DataFrame,
    form_window: int = DEFAULT_FORM_WINDOW,
    decay: float = DEFAULT_DECAY,
) -> list[DriverForm]:
    """
    Recent-form samples for every driver on the current grid.

    *results* must already be cut at the as-of point. The current grid is the line-up of the
    latest Grand Prix in it: drivers who have left keep their points but draw no more results,
    and a replacement is in from their first race. Only the current season counts — form
    from before a regulation change says little about the cars after it.
    """
    frame = _with_wins(results)
    races = frame[(frame["session_type"] == "R") & frame["position"].notna()]
    if races.empty:
        return []
    grid = races[races["round_number"] == races["round_number"].max()].sort_values("position")

    history = {
        str(driver): group.sort_values("round_number", ascending=False)["position"].to_numpy(dtype=float)[
            :form_window
        ]
        for driver, group in races.groupby("driver")
    }
    field_median = (len(grid) + 1) / 2

    forms = []
    for row in grid.itertuples(index=False):
        driver = str(row.driver)
        own = history.get(driver, np.empty(0))
        pieces, source = [own], "own"
        if len(own) < MIN_FORM_RESULTS:
            mates = [
                history[str(mate)]
                for mate in grid.loc[grid["team"] == row.team, "driver"]
                if str(mate) != driver and str(mate) in history
            ]
            if mates:
                pieces, source = [own, *mates], "pooled"
            else:
                pieces, source = [own, np.full(MIN_FORM_RESULTS - len(own), field_median)], "field"
        forms.append(
            DriverForm(
                driver=driver,
                team=_clean_team(row.team),
                positions=np.concatenate(pieces),
                weights=np.concatenate([decay ** np.arange(len(p)) for p in pieces]),
                n_own=len(own),
                source=source,
            )
        )
    return forms


# ── Simulation ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SimulationOptions:
    n_sims: int = DEFAULT_N_SIMS
    form_window: int = DEFAULT_FORM_WINDOW
    decay: float = DEFAULT_DECAY
    noise_sd: float = DEFAULT_NOISE_SD
    dnf_floor: float = DEFAULT_DNF_FLOOR
    drift_sd: float = DEFAULT_DRIFT_SD
    seed: int = 0


@dataclass(frozen=True)
class Pin:
    """A what-if result fixed in every simulated season. ``position=None`` is a DNF."""

    round_number: int
    session_type: str
    driver: str
    position: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate_pins(
    pins: Sequence[Pin],
    remaining: Sequence[ScoringSession],
    forms: Sequence[DriverForm],
    aliases: dict[str, str] | None = None,
) -> list[Pin]:
    """
    Check what-if pins against the projection they apply to, returning them normalised.

    Drivers may be given as an abbreviation or a car number, like every driver parameter in
    the API (*aliases* maps car numbers to abbreviations). Raises ValueError with a message
    fit for a 400 response.
    """
    aliases = aliases or {}
    remaining_keys = {s.key for s in remaining}
    grid = {f.driver for f in forms}
    seen_drivers: set[tuple[tuple[int, str], str]] = set()
    seen_positions: set[tuple[tuple[int, str], int]] = set()

    normalised = []
    for pin in pins:
        session_type = pin.session_type.upper()
        key = (pin.round_number, session_type)
        label = f"Round {pin.round_number} {_session_label(session_type)}"
        if key not in remaining_keys:
            raise ValueError(f"{label} is not a remaining session at this point in the season")
        driver = aliases.get(str(pin.driver).upper(), str(pin.driver).upper())
        if driver not in grid:
            raise ValueError(f"{pin.driver} is not on the current grid")
        if (key, driver) in seen_drivers:
            raise ValueError(f"{driver} is pinned more than once in {label}")
        seen_drivers.add((key, driver))
        if pin.position is not None:
            if not 1 <= pin.position <= len(grid):
                raise ValueError(f"Pinned positions must be between 1 and {len(grid)}")
            if (key, pin.position) in seen_positions:
                raise ValueError(f"P{pin.position} is pinned more than once in {label}")
            seen_positions.add((key, pin.position))
        normalised.append(Pin(pin.round_number, session_type, driver, pin.position))
    return normalised


def _sampling_tables(forms: Sequence[DriverForm]) -> tuple[np.ndarray, np.ndarray]:
    """Pad every driver's form into ``(n_drivers, width)`` sample and cumulative-weight arrays."""
    width = max(len(f.positions) for f in forms)
    samples = np.zeros((len(forms), width))
    cumulative = np.ones((len(forms), width))
    for i, form in enumerate(forms):
        weights = np.cumsum(form.weights)
        weights /= weights[-1]
        weights[-1] = 1.0  # exact, so a uniform draw in [0, 1) can never index past the end
        samples[i, : len(form.positions)] = form.positions
        cumulative[i, : len(weights)] = weights
    return samples, cumulative


def _rank(score: np.ndarray, fixed: dict[int, int]) -> np.ndarray:
    """
    Turn per-driver scores of shape ``(n_sims, n_drivers)`` into 0-based finishing ranks.

    Pinned drivers take their fixed rank; everyone else fills the free ranks in score order,
    lowest first.
    """
    n_sims, n_drivers = score.shape
    ranks = np.empty((n_sims, n_drivers), dtype=np.int64)
    for driver, rank in fixed.items():
        ranks[:, driver] = rank
    free_drivers = np.array([i for i in range(n_drivers) if i not in fixed], dtype=np.int64)
    taken = set(fixed.values())
    free_ranks = np.array([r for r in range(n_drivers) if r not in taken], dtype=np.int64)
    if len(free_drivers):
        order = np.argsort(score[:, free_drivers], axis=1, kind="stable")
        ranks[np.arange(n_sims)[:, None], free_drivers[order]] = free_ranks[None, :]
    return ranks


def simulate_sessions(
    forms: Sequence[DriverForm],
    sessions: Sequence[ScoringSession],
    ps: PointsSystem,
    options: SimulationOptions,
    rng: np.random.Generator,
    pins: Sequence[Pin] = (),
) -> tuple[np.ndarray, np.ndarray]:
    """
    Simulate every session in *sessions* ``options.n_sims`` times.

    Returns ``(points, wins)``: points of shape ``(n_sessions, n_sims, n_drivers)``, and Grand
    Prix wins per simulated season of shape ``(n_sims, n_drivers)``, both in *forms* order.
    Pins must already have been through :func:`validate_pins`.
    """
    n_drivers, n_sims = len(forms), options.n_sims
    points = np.zeros((len(sessions), n_sims, n_drivers))
    wins = np.zeros((n_sims, n_drivers), dtype=np.int64)
    if n_drivers == 0:
        return points, wins

    samples, cumulative = _sampling_tables(forms)
    index = {form.driver: i for i, form in enumerate(forms)}
    pins_by_session: dict[tuple[int, str], list[Pin]] = defaultdict(list)
    for pin in pins:
        pins_by_session[(pin.round_number, pin.session_type)].append(pin)

    # One pace offset per driver per simulated season, shared by all of that season's sessions.
    drift = rng.normal(0.0, options.drift_sd, size=(n_sims, n_drivers))

    for j, session in enumerate(sessions):
        # Draw every random number before looking at pins, so a what-if consumes exactly the
        # same stream as the baseline and the two differ only where pinned.
        uniform = rng.random((n_sims, n_drivers))
        noise = rng.normal(0.0, options.noise_sd, size=(n_sims, n_drivers))
        retired = rng.random((n_sims, n_drivers)) < options.dnf_floor

        drawn = np.empty((n_sims, n_drivers))
        for i in range(n_drivers):
            drawn[:, i] = samples[i, np.searchsorted(cumulative[i], uniform[:, i], side="right")]
        score = drawn + noise + drift

        fixed: dict[int, int] = {}
        for pin in pins_by_session.get(session.key, ()):
            i = index[pin.driver]
            if pin.position is None:
                retired[:, i] = True
            else:
                fixed[i] = pin.position - 1
                retired[:, i] = False
        score[retired] = np.inf

        ranks = _rank(score, fixed)
        scale = ps.table(session.session_type)[:n_drivers]
        by_rank = np.zeros(n_drivers)
        by_rank[: len(scale)] = scale
        session_points = by_rank[ranks]
        # A retirement scores nothing even in a field too small to push it out of the points.
        session_points[retired] = 0.0
        points[j] = session_points
        if session.session_type == "R":
            wins += (ranks == 0) & ~retired
    return points, wins


def _final_ranks(points: np.ndarray, wins: np.ndarray, tiebreak: np.ndarray) -> np.ndarray:
    """
    Championship rank (0 = champion) per simulated season: points, then wins, then a coin toss.

    Real countback continues with second places, third places and so on; the coin toss
    stands in for it because exact ties on points are rare enough not to justify tracking
    every finishing position.
    """
    order = np.lexsort((tiebreak, -wins, -points), axis=1)
    ranks = np.empty_like(order)
    ranks[np.arange(order.shape[0])[:, None], order] = np.arange(order.shape[1])[None, :]
    return ranks


# ── Elimination ────────────────────────────────────────────────────────


def max_points_remaining(sessions: Sequence[ScoringSession], ps: PointsSystem, team: bool = False) -> float:
    """Most one driver (or, with *team*, one constructor) can still score in *sessions*."""
    per_session = ps.max_team_points if team else ps.max_driver_points
    return float(sum(per_session(s.session_type) for s in sessions))


def championship_status(points: np.ndarray, eligible: np.ndarray, max_remaining: float) -> list[str]:
    """
    ``"clinched"``, ``"alive"`` or ``"eliminated"`` for each contender.

    Alive means a contender could still at least tie the current leader (``>=``), since a tie
    can still be won on countback. Clinched means no rival can even tie. A contender who can
    no longer score (*eligible* False — e.g. a driver who has left the grid) keeps only the
    points they have.
    """
    max_possible = points + np.where(eligible, max_remaining, 0.0)
    leader = points.max(initial=0.0)
    statuses = []
    for i in range(len(points)):
        rival_best = np.delete(max_possible, i).max(initial=-np.inf)
        if points[i] > rival_best:
            statuses.append("clinched")
        elif max_possible[i] >= leader:
            statuses.append("alive")
        else:
            statuses.append("eliminated")
    return statuses


def earliest_clinch(
    points: np.ndarray,
    eligible: np.ndarray,
    remaining: Sequence[ScoringSession],
    max_points: Callable[[str], float],
) -> ScoringSession | None:
    """
    The first remaining session after which the current leader could have the title sewn up.

    That is the best case for the leader: maximum points in every session up to that one,
    while every rival scores nothing — after which no rival can catch them even by winning
    everything left. Uses a strict ``>``, so it is conservative where countback could settle
    a tie. ``points`` must be in standings order (leader first). Returns None when the title
    is already decided, or cannot be decided before the season ends.
    """
    if len(points) < 2 or not remaining:
        return None
    rivals, rival_eligible = points[1:], eligible[1:]
    total = sum(max_points(s.session_type) for s in remaining)
    if points[0] > (rivals + np.where(rival_eligible, total, 0.0)).max():
        return None  # already clinched
    through = 0.0
    for session in remaining:
        through += max_points(session.session_type)
        leader_best = points[0] + (through if eligible[0] else 0.0)
        rivals_best = (rivals + np.where(rival_eligible, total - through, 0.0)).max()
        if leader_best > rivals_best:
            return session
    return None


# ── Projection ─────────────────────────────────────────────────────────


def _r(value: Any, digits: int) -> float | None:
    """Round for JSON, mapping non-finite values to None so the payload stays valid JSON."""
    if value is None:
        return None
    value = float(value)
    if not np.isfinite(value):
        return None
    return round(value, digits)


def _standings(frame: pd.DataFrame, key: str) -> pd.DataFrame:
    """Points and Grand Prix wins per *key*, in championship order (points, wins, name)."""
    grouped = frame.groupby(key)
    table = pd.DataFrame({"points": grouped["points"].sum(), "wins": grouped["win"].sum()})
    order = sorted(table.index, key=lambda k: (-table.at[k, "points"], -table.at[k, "wins"], k))
    return table.loc[order]


def _trajectory(
    base: np.ndarray,
    session_points: np.ndarray,
    remaining: Sequence[ScoringSession],
) -> list[list[dict[str, Any]]]:
    """Cumulative points p10/p50/p90 after each remaining round, per contender."""
    out: list[list[dict[str, Any]]] = [[] for _ in range(len(base))]
    running = np.broadcast_to(base, session_points.shape[1:]).copy()
    for rnd in sorted({s.round_number for s in remaining}):
        in_round = [j for j, s in enumerate(remaining) if s.round_number == rnd]
        running += session_points[in_round].sum(axis=0)
        p10, p50, p90 = np.percentile(running, [10, 50, 90], axis=0)
        for i in range(len(base)):
            out[i].append({"round_number": rnd, "p10": _r(p10[i], 1), "p50": _r(p50[i], 1), "p90": _r(p90[i], 1)})
    return out


def _contenders(
    names: list[str],
    base_points: np.ndarray,
    base_wins: np.ndarray,
    eligible: np.ndarray,
    totals: np.ndarray,
    ranks: np.ndarray,
    trajectory: list[list[dict[str, Any]]],
    max_remaining: float,
    actual: pd.DataFrame | None,
) -> list[dict[str, Any]]:
    """Per-contender summary rows, shared by the driver and constructor tables."""
    if not names:
        return []
    statuses = championship_status(base_points, eligible, max_remaining)
    depth = min(POSITION_PROBABILITY_DEPTH, len(names))
    position_probabilities = np.stack([(ranks == k).mean(axis=0) for k in range(depth)], axis=1)
    expected = totals.mean(axis=0)
    p10, p90 = np.percentile(totals, [10, 90], axis=0)
    leader = base_points[0]
    actual_positions = {name: i + 1 for i, name in enumerate(actual.index)} if actual is not None else {}

    rows = []
    for i, name in enumerate(names):
        rows.append(
            {
                "position": i + 1,
                "points": _r(base_points[i], 1),
                "wins": int(base_wins[i]),
                "gap_to_leader": _r(leader - base_points[i], 1),
                "eligible": bool(eligible[i]),
                "max_possible": _r(base_points[i] + (max_remaining if eligible[i] else 0.0), 1),
                "status": statuses[i],
                "title_probability": _r(position_probabilities[i, 0], 4),
                "expected_points": _r(expected[i], 1),
                "points_p10": _r(p10[i], 1),
                "points_p90": _r(p90[i], 1),
                "position_probabilities": [_r(p, 4) for p in position_probabilities[i]],
                "trajectory": trajectory[i],
                "actual_points": _r(actual.at[name, "points"], 1) if name in actual_positions else None,
                "actual_position": actual_positions.get(name),
            }
        )
    return rows


def project_championship(
    year: int,
    results: pd.DataFrame,
    calendar: Sequence[dict[str, Any]],
    as_of_round: int | None = None,
    options: SimulationOptions | None = None,
    pins: Sequence[Pin] = (),
) -> dict[str, Any]:
    """
    Payload for ``/championship/projection``: elimination, title odds and trajectories.

    Raises ValueError for an out-of-range *as_of_round* or an invalid pin.
    """
    options = options or SimulationOptions()
    ps = points_system(year)
    schedule = build_schedule(year, calendar, results, as_of_round)
    remaining = schedule.remaining

    frame = _with_wins(results)
    completed = {s.key for s in schedule.completed}
    done = frame[[key in completed for key in zip(frame["round_number"], frame["session_type"])]]

    forms = driver_form(done, options.form_window, options.decay)
    aliases = {
        str(int(number)): str(driver)
        for driver, number in frame[["driver", "driver_number"]].dropna().itertuples(index=False)
    }
    pins = validate_pins(pins, remaining, forms, aliases)

    # ── Drivers ──
    standings = _standings(done, "driver")
    drivers = [str(d) for d in standings.index]
    n_sims, n_drivers = options.n_sims, len(drivers)
    base_points = standings["points"].to_numpy(dtype=float)
    base_wins = standings["wins"].to_numpy(dtype=float)
    column = {driver: i for i, driver in enumerate(drivers)}
    on_grid = np.array([column[f.driver] for f in forms], dtype=np.int64)
    eligible = np.zeros(n_drivers, dtype=bool)
    eligible[on_grid] = True

    rng = np.random.default_rng(options.seed)
    grid_points, grid_wins = simulate_sessions(forms, remaining, ps, options, rng, pins)
    session_points = np.zeros((len(remaining), n_sims, n_drivers))
    session_points[:, :, on_grid] = grid_points
    sim_wins = np.zeros((n_sims, n_drivers))
    sim_wins[:, on_grid] = grid_wins

    totals = base_points + session_points.sum(axis=0)
    total_wins = base_wins + sim_wins
    driver_ranks = _final_ranks(totals, total_wins, rng.random((n_sims, n_drivers)))

    # ── Constructors ──
    # A driver's simulated points go to the team they race for now; points already scored
    # stay with the team they were scored for, which the team standings below already reflect.
    latest_team = done.sort_values("round_number").groupby("driver")["team"].last()
    team_of = {driver: _clean_team(latest_team.get(driver)) for driver in drivers}
    team_of.update({f.driver: f.team for f in forms})
    team_standings = _standings(done[_has_team(done)], "team")
    teams = [str(t) for t in team_standings.index]
    membership = np.zeros((n_drivers, len(teams)))
    team_column = {team: k for k, team in enumerate(teams)}
    for driver, i in column.items():
        if team_of.get(driver) in team_column:
            membership[i, team_column[team_of[driver]]] = 1.0
    team_base_points = team_standings["points"].to_numpy(dtype=float)
    team_base_wins = team_standings["wins"].to_numpy(dtype=float)
    team_eligible = (membership * eligible[:, None]).sum(axis=0) > 0
    team_session_points = session_points @ membership
    team_totals = team_base_points + team_session_points.sum(axis=0)
    team_ranks = _final_ranks(team_totals, team_base_wins + sim_wins @ membership, rng.random((n_sims, len(teams))))

    # ── Elimination ──
    max_driver = max_points_remaining(remaining, ps)
    max_team = max_points_remaining(remaining, ps, team=True)
    driver_clinch = earliest_clinch(base_points, eligible, remaining, ps.max_driver_points)
    team_clinch = earliest_clinch(team_base_points, team_eligible, remaining, ps.max_team_points)

    actual_drivers = actual_teams = None
    if schedule.is_backtest:
        actual_drivers = _standings(frame, "driver")
        actual_teams = _standings(frame[_has_team(frame)], "team")

    driver_rows = _contenders(
        drivers,
        base_points,
        base_wins,
        eligible,
        totals,
        driver_ranks,
        _trajectory(base_points, session_points, remaining),
        max_driver,
        actual_drivers,
    )
    form_by_driver = {f.driver: f for f in forms}
    for driver, row in zip(drivers, driver_rows):
        form = form_by_driver.get(driver)
        row.update(
            {
                "driver": driver,
                "team": team_of.get(driver),
                "form": {"n_results": form.n_own, "source": form.source} if form else None,
            }
        )

    team_rows = _contenders(
        teams,
        team_base_points,
        team_base_wins,
        team_eligible,
        team_totals,
        team_ranks,
        _trajectory(team_base_points, team_session_points, remaining),
        max_team,
        actual_teams,
    )
    for team, row in zip(teams, team_rows):
        row["team"] = team

    return {
        "year": year,
        "as_of_round": schedule.as_of_round,
        "as_of_session": schedule.as_of_session.to_dict(),
        "latest_round": schedule.latest_round,
        "is_backtest": schedule.is_backtest,
        "is_scenario": bool(pins),
        "season_complete": schedule.season_complete,
        "config": asdict(options),
        "points_system": ps.to_dict(),
        "rounds": schedule.rounds,
        "remaining": [
            {
                **s.to_dict(),
                "max_driver_points": ps.max_driver_points(s.session_type),
                "max_team_points": ps.max_team_points(s.session_type),
            }
            for s in remaining
        ],
        "max_points_remaining": {"driver": max_driver, "team": max_team},
        "earliest_clinch": {
            "drivers": driver_clinch.to_dict() if driver_clinch else None,
            "constructors": team_clinch.to_dict() if team_clinch else None,
        },
        "pins": [p.to_dict() for p in pins],
        "drivers": driver_rows,
        "constructors": team_rows,
        "warnings": schedule.warnings,
        "method": describe_method(year, ps, options, len(remaining)),
    }


def describe_method(year: int, ps: PointsSystem, options: SimulationOptions, n_remaining: int) -> dict[str, Any]:
    """The model and its blind spots, in prose, for the page to show next to the odds."""
    sessions = f"{n_remaining} remaining session{'' if n_remaining == 1 else 's'}"
    summary = (
        f"Each of {options.n_sims:,} simulated seasons replays the {sessions}. In every session each "
        f"driver draws one of their last {options.form_window} Grand Prix finishing positions — recent "
        f"races weigh more, ×{options.decay} per race back — adds random noise of σ = {options.noise_sd} "
        f"places, and has a {options.dnf_floor:.0%} chance of retiring. Each driver also carries a pace "
        f"drift (σ = {options.drift_sd} places) that holds for the whole simulated season, standing in "
        "for upgrades and swings in form. Sorting gives a finishing order, scored with the "
        f"{year} points table. Title odds are the share of simulated seasons a driver or team ends on top."
    )
    caveats = [
        "Form is current-season only, so odds early in a season rest on very few races.",
        "Sprints are simulated from Grand Prix form; there are too few sprints to model them separately.",
        "Upgrades, grid penalties, team orders and weather are not modelled directly; the pace drift is "
        "a generic allowance for change, not a forecast of who will improve.",
        "Ties on points are broken by wins, then at random; real countback continues with second places.",
        "Reduced points for shortened races are not modelled.",
    ]
    if ps.fastest_lap:
        caveats.insert(
            2,
            "The fastest-lap point counts towards who can still win, but is never awarded in simulation.",
        )
    return {"summary": summary, "calibration": CALIBRATION, "caveats": caveats}
