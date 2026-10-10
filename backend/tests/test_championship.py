"""
Tests for the championship projection: points rules, the schedule split, progression, the
elimination maths, the simulation's invariants, and the HTTP layer.

Model tests run on in-memory frames — the miniature 2022 season in
``fixtures/seed_results.py``, or a few hand-built rows. API tests run the same season through
``TestClient`` against the seeded in-memory database.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.api.main import app
from backend.ml import championship as ch
from backend.tests.fixtures.seed_results import YEAR, season_calendar, season_results_frame, seed_season

FAST = ch.SimulationOptions(n_sims=2_000, seed=7)


# ── Helpers ────────────────────────────────────────────────────────────

def _session(round_number: int, session_type: str) -> ch.ScoringSession:
    return ch.ScoringSession(round_number, session_type, f"Round {round_number}")


def _run_in_2026() -> list[ch.ScoringSession]:
    """The shape of the 2026 run-in after round 16: the Singapore sprint, then seven Grands Prix."""
    return [_session(17, "S"), *(_session(r, "R") for r in range(17, 24))]


def _rows(*rows: tuple) -> pd.DataFrame:
    """A results frame from ``(round, session_type, driver, team, position, points)`` tuples."""
    return pd.DataFrame(
        [
            {
                "round_number": rnd,
                "session_type": session_type,
                "event_name": f"Round {rnd}",
                "driver": driver,
                "driver_number": None,
                "team": team,
                "position": position,
                "status": "Finished",
                "points": points,
            }
            for rnd, session_type, driver, team, position, points in rows
        ]
    )


def _calendar(*formats: str) -> list[dict]:
    return [
        {"round_number": i, "event_name": f"Round {i}", "event_format": fmt}
        for i, fmt in enumerate(formats, start=1)
    ]


def _forms(n: int) -> list[ch.DriverForm]:
    """*n* drivers whose form is one fixed result each: D00 always wins, D01 is always second…"""
    return [
        ch.DriverForm(
            driver=f"D{i:02d}",
            team=f"T{i // 2}",
            positions=np.array([float(i + 1)]),
            weights=np.array([1.0]),
            n_own=1,
            source="own",
        )
        for i in range(n)
    ]


def _project(calendar: list[dict] | None = None, **kwargs) -> dict:
    kwargs.setdefault("options", FAST)
    return ch.project_championship(
        YEAR, season_results_frame(), season_calendar() if calendar is None else calendar, **kwargs
    )


# ── Points rules ───────────────────────────────────────────────────────

def test_points_rules_follow_the_era():
    assert ch.points_system(2018).sprint == ()
    assert ch.points_system(2018).max_driver_points("R") == 25

    rules_2021 = ch.points_system(2021)
    assert rules_2021.sprint == (3, 2, 1)
    assert rules_2021.max_driver_points("R") == 26  # a win plus the fastest-lap point
    assert rules_2021.max_team_points("S") == 5

    rules_2026 = ch.points_system(2026)
    assert rules_2026.fastest_lap == 0
    assert rules_2026.max_driver_points("S") == 8
    assert rules_2026.max_team_points("R") == 43


def test_max_points_remaining_for_the_2026_run_in():
    rules = ch.points_system(2026)
    assert ch.max_points_remaining(_run_in_2026(), rules) == 183
    assert ch.max_points_remaining(_run_in_2026(), rules, team=True) == 316


# ── Elimination ────────────────────────────────────────────────────────

def test_alive_boundary_is_inclusive():
    # 137 + 183 = 320 can still tie the leader, and a tie can still be won on countback.
    statuses = ch.championship_status(np.array([320.0, 137.0, 136.0]), np.ones(3, dtype=bool), 183)
    assert statuses == ["alive", "alive", "eliminated"]


def test_clinched_when_no_rival_can_even_tie():
    statuses = ch.championship_status(np.array([320.0, 100.0]), np.ones(2, dtype=bool), 183)
    assert statuses == ["clinched", "eliminated"]


def test_a_driver_off_the_grid_keeps_points_but_cannot_add_to_them():
    # The leader has left the grid, so 150 stands still; the rival's best is 100 + 40.
    statuses = ch.championship_status(np.array([150.0, 100.0]), np.array([False, True]), 40)
    assert statuses == ["clinched", "eliminated"]


def test_earliest_clinch_for_the_2026_standings():
    # 320 v 236 with 183 left: the leader's best case settles it after the US Grand Prix.
    session = ch.earliest_clinch(
        np.array([320.0, 236.0, 214.0]),
        np.ones(3, dtype=bool),
        _run_in_2026(),
        ch.points_system(2026).max_driver_points,
    )
    assert session is not None and session.key == (18, "R")


def test_no_earliest_clinch_once_the_title_is_decided():
    session = ch.earliest_clinch(
        np.array([320.0, 100.0]), np.ones(2, dtype=bool), _run_in_2026(), ch.points_system(2026).max_driver_points
    )
    assert session is None


# ── Schedule ───────────────────────────────────────────────────────────

def test_schedule_splits_a_sprint_weekend_part_way_through():
    results = _rows((1, "R", "AAA", "A", 1, 25), (2, "S", "AAA", "A", 1, 8))
    schedule = ch.build_schedule(2026, _calendar("conventional", "sprint_qualifying"), results)

    assert schedule.as_of_round == 2
    assert schedule.as_of_session.key == (2, "S")
    assert [s.key for s in schedule.completed] == [(1, "R"), (2, "S")]
    assert [s.key for s in schedule.remaining] == [(2, "R")]
    assert not schedule.is_backtest


def test_schedule_skips_testing_and_warns_about_missing_results():
    results = _rows((1, "R", "AAA", "A", 1, 25), (3, "R", "AAA", "A", 1, 25))
    calendar = [
        {"round_number": 0, "event_name": "Pre-Season Testing", "event_format": "testing"},
        *_calendar("conventional", "conventional", "conventional", "conventional"),
    ]
    schedule = ch.build_schedule(2026, calendar, results)

    assert [r["round_number"] for r in schedule.rounds] == [1, 2, 3, 4]
    # Round 2 happened but was never ingested: reported, not simulated.
    assert [s.key for s in schedule.remaining] == [(4, "R")]
    assert any("Round 2" in w for w in schedule.warnings)


def test_schedule_without_a_calendar_projects_nothing():
    schedule = ch.build_schedule(2026, [], _rows((1, "R", "AAA", "A", 1, 25)))
    assert schedule.remaining == []
    assert not schedule.season_complete
    assert any("No calendar" in w for w in schedule.warnings)


def test_schedule_rejects_an_as_of_round_without_results():
    with pytest.raises(ValueError, match="as_of_round"):
        ch.build_schedule(YEAR, season_calendar(), season_results_frame(), as_of_round=4)


# ── Progression ────────────────────────────────────────────────────────

def test_progression_tracks_lead_changes():
    progression = ch.points_progression(season_results_frame())
    drivers = {d["driver"]: d for d in progression["drivers"]}
    teams = {t["team"]: t for t in progression["constructors"]}

    assert progression["round_numbers"] == [1, 2, 3]
    assert [d["driver"] for d in progression["drivers"]] == ["AAA", "CCC", "BBB", "DDD"]
    assert drivers["AAA"]["cumulative"] == [25, 50, 75]
    assert drivers["AAA"]["positions"] == [1, 2, 1]
    assert drivers["CCC"]["positions"] == [2, 1, 2]
    assert drivers["DDD"]["positions"] == [4, 3, 4]
    assert (drivers["AAA"]["wins"], drivers["CCC"]["wins"]) == (2, 1)
    assert teams["Alpha"]["cumulative"] == [40, 82, 125]
    assert teams["Beta"]["positions"] == [2, 1, 2]


def test_progression_starts_a_debut_where_it_happened():
    results = _rows((1, "R", "AAA", "A", 1, 25), (2, "R", "AAA", "A", 2, 18), (2, "R", "NEW", "A", 1, 25))
    drivers = {d["driver"]: d for d in ch.points_progression(results)["drivers"]}
    assert drivers["NEW"]["cumulative"] == [None, 25]
    assert drivers["NEW"]["positions"] == [None, 2]


# ── Form ───────────────────────────────────────────────────────────────

def test_a_replacement_borrows_team_mate_form_and_the_driver_replaced_stops_scoring():
    results = _rows(
        (1, "R", "MAT", "B", 1, 25), (1, "R", "OLD", "B", 2, 18),
        (2, "R", "MAT", "B", 1, 25), (2, "R", "OLD", "B", 2, 18),
        (3, "R", "MAT", "B", 2, 18), (3, "R", "NEW", "B", 1, 25),
    )
    forms = {f.driver: f for f in ch.driver_form(results)}
    assert set(forms) == {"MAT", "NEW"}
    assert (forms["NEW"].source, forms["NEW"].n_own, len(forms["NEW"].positions)) == ("pooled", 1, 4)
    assert forms["MAT"].source == "own"

    projection = ch.project_championship(2026, results, _calendar(*["conventional"] * 4), options=FAST)
    old = next(d for d in projection["drivers"] if d["driver"] == "OLD")
    assert not old["eligible"]
    assert old["max_possible"] == old["points"] == 36


# ── Simulation ─────────────────────────────────────────────────────────

def test_same_seed_gives_identical_odds():
    first, second = _project(), _project()
    assert first["drivers"] == second["drivers"]

    reseeded = _project(options=ch.SimulationOptions(n_sims=2_000, seed=8))
    assert [d["expected_points"] for d in reseeded["drivers"]] != [d["expected_points"] for d in first["drivers"]]


def test_title_probabilities_sum_to_one():
    projection = _project()
    for table in ("drivers", "constructors"):
        assert sum(row["title_probability"] for row in projection[table]) == pytest.approx(1.0, abs=1e-3)


def test_with_nothing_left_to_race_the_leader_is_champion():
    projection = _project(calendar=[row for row in season_calendar() if row["round_number"] <= 3])
    leader = projection["drivers"][0]
    assert projection["remaining"] == [] and projection["season_complete"]
    assert (leader["driver"], leader["title_probability"], leader["status"]) == ("AAA", 1.0, "clinched")


def test_an_insurmountable_lead_is_certain():
    # 2026 rules with one Grand Prix left: a 40-point lead cannot be overturned by 25.
    results = _rows(
        (1, "R", "AAA", "A", 1, 25), (1, "R", "BBB", "B", 2, 5),
        (2, "R", "AAA", "A", 1, 25), (2, "R", "BBB", "B", 2, 5),
    )
    projection = ch.project_championship(2026, results, _calendar(*["conventional"] * 3), options=FAST)
    assert {d["driver"]: d["title_probability"] for d in projection["drivers"]} == {"AAA": 1.0, "BBB": 0.0}
    assert projection["drivers"][0]["status"] == "clinched"


def test_every_simulated_session_awards_each_points_value_once():
    rules = ch.points_system(2026)
    options = ch.SimulationOptions(n_sims=500, dnf_floor=0.0, seed=1)
    sessions = [_session(1, "S"), _session(1, "R")]
    points, _ = ch.simulate_sessions(_forms(12), sessions, rules, options, np.random.default_rng(1))

    for j, table in enumerate((rules.sprint, rules.race)):
        expected = np.sort(np.concatenate([table, np.zeros(12 - len(table))]))
        assert (np.sort(points[j], axis=1) == expected).all()


def test_pins_fix_a_result_in_every_simulated_season():
    forms, session = _forms(6), _session(1, "R")
    pins = ch.validate_pins([ch.Pin(1, "R", "D05", 1), ch.Pin(1, "R", "D00", None)], [session], forms)
    points, wins = ch.simulate_sessions(forms, [session], ch.points_system(2026), FAST, np.random.default_rng(0), pins)

    assert (points[0][:, 5] == 25).all()  # the slowest driver, pinned to win
    assert (wins[:, 5] == 1).all()
    assert (points[0][:, 0] == 0).all()  # the fastest, pinned to retire


def test_pins_leave_other_sessions_untouched():
    # Common random numbers: pinning Race 2 must not reshuffle Race 1.
    forms, sessions, rules = _forms(6), [_session(1, "R"), _session(2, "R")], ch.points_system(2026)
    baseline, _ = ch.simulate_sessions(forms, sessions, rules, FAST, np.random.default_rng(3))
    pins = ch.validate_pins([ch.Pin(2, "R", "D03", 1)], sessions, forms)
    pinned, _ = ch.simulate_sessions(forms, sessions, rules, FAST, np.random.default_rng(3), pins)

    assert (pinned[0] == baseline[0]).all()
    assert not (pinned[1] == baseline[1]).all()


def test_validate_pins_rejects_impossible_scenarios():
    forms, remaining = _forms(4), [_session(5, "R")]
    cases = [
        ([ch.Pin(4, "R", "D00", 1)], "not a remaining session"),
        ([ch.Pin(5, "R", "ZZZ", 1)], "not on the current grid"),
        ([ch.Pin(5, "R", "D00", 1), ch.Pin(5, "R", "D00", 2)], "D00 is pinned more than once"),
        ([ch.Pin(5, "R", "D00", 1), ch.Pin(5, "R", "D01", 1)], "P1 is pinned more than once"),
        ([ch.Pin(5, "R", "D00", 9)], "between 1 and 4"),
    ]
    for pins, message in cases:
        with pytest.raises(ValueError, match=message):
            ch.validate_pins(pins, remaining, forms)


def test_validate_pins_accepts_a_car_number_and_any_case():
    pins = ch.validate_pins([ch.Pin(5, "r", "44", 2)], [_session(5, "R")], _forms(4), aliases={"44": "D02"})
    assert pins == [ch.Pin(5, "R", "D02", 2)]


def test_constructors_are_the_sum_of_their_drivers():
    projection = _project()
    drivers = {d["driver"]: d["expected_points"] for d in projection["drivers"]}
    teams = {t["team"]: t["expected_points"] for t in projection["constructors"]}
    assert teams["Alpha"] == pytest.approx(drivers["AAA"] + drivers["BBB"], abs=0.2)
    assert teams["Beta"] == pytest.approx(drivers["CCC"] + drivers["DDD"], abs=0.2)


# ── HTTP layer ─────────────────────────────────────────────────────────

@pytest.fixture
def client(duckdb_conn):
    seed_season(duckdb_conn)
    with TestClient(app) as test_client:
        yield test_client


def _get(client, path: str, **params) -> dict:
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_progression_endpoint(client):
    payload = _get(client, "/api/championship/progression", year=YEAR)
    assert payload["round_numbers"] == [1, 2, 3]
    assert payload["latest_round"] == 3
    assert [r["round_number"] for r in payload["rounds"]] == [1, 2, 3, 4, 5]
    assert [d["driver"] for d in payload["drivers"]] == ["AAA", "CCC", "BBB", "DDD"]
    assert payload["constructors"][0]["team"] == "Alpha"


def test_progression_agrees_with_the_standings_endpoint(client):
    progression = _get(client, "/api/championship/progression", year=YEAR)
    standings = _get(client, "/api/standings/drivers", year=YEAR)
    assert {d["driver"]: d["points"] for d in progression["drivers"]} == {s["driver"]: s["points"] for s in standings}


def test_projection_endpoint(client):
    payload = _get(client, "/api/championship/projection", year=YEAR, n_sims=1000)

    assert [(s["round_number"], s["session_type"]) for s in payload["remaining"]] == [(4, "S"), (4, "R"), (5, "R")]
    assert payload["max_points_remaining"] == {"driver": 60, "team": 103}
    clinch = payload["earliest_clinch"]["drivers"]
    assert (clinch["round_number"], clinch["session_type"]) == (4, "R")
    assert all(d["status"] == "alive" for d in payload["drivers"])
    assert not payload["is_backtest"] and not payload["is_scenario"]
    assert payload["config"]["n_sims"] == 1000


def test_projection_backtest_reports_what_happened(client):
    payload = _get(client, "/api/championship/projection", year=YEAR, as_of_round=2, n_sims=1000)
    leader = payload["drivers"][0]

    assert payload["is_backtest"]
    assert payload["remaining"][0]["round_number"] == 3
    assert leader["driver"] == "CCC"  # led after round 2…
    assert (leader["actual_points"], leader["actual_position"]) == (66, 2)  # …and finished second


def test_pinned_scenario_is_honoured(client):
    body = {
        "year": YEAR,
        "n_sims": 1000,
        "pins": [
            {"round_number": 4, "session_type": "R", "driver": "DDD", "position": 1},
            {"round_number": 5, "session_type": "R", "driver": "4", "position": 1},  # DDD by car number
        ],
    }
    response = client.post("/api/championship/projection", json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    ddd = next(d for d in payload["drivers"] if d["driver"] == "DDD")

    assert payload["is_scenario"]
    assert [p["driver"] for p in payload["pins"]] == ["DDD", "DDD"]
    assert ddd["trajectory"][-1]["p10"] >= 45 + 25 + 25  # two pinned wins, whatever the sprint does


@pytest.mark.parametrize(
    "pin",
    [
        {"round_number": 3, "session_type": "R", "driver": "AAA", "position": 1},  # already run
        {"round_number": 4, "session_type": "R", "driver": "ZZZ", "position": 1},  # not on the grid
    ],
)
def test_invalid_pins_are_rejected(client, pin):
    response = client.post("/api/championship/projection", json={"year": YEAR, "n_sims": 1000, "pins": [pin]})
    assert response.status_code == 400


def test_a_season_without_results_is_404(client):
    assert client.get("/api/championship/projection", params={"year": 2030}).status_code == 404
    assert client.get("/api/championship/progression", params={"year": 2030}).status_code == 404


def test_an_as_of_round_without_results_is_400(client):
    assert client.get("/api/championship/projection", params={"year": YEAR, "as_of_round": 9}).status_code == 400


def test_simulation_count_is_bounded(client):
    assert client.get("/api/championship/projection", params={"year": YEAR, "n_sims": 10}).status_code == 422
