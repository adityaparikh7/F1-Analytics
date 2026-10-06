"""
Tests for the tyre degradation HTTP layer.

Runs against the in-memory seeded database via ``TestClient``, so these exercise real
routing, parameter validation and serialisation without a server or the project's DuckDB.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api.main import app
from backend.api.tyres import clear_cache


@pytest.fixture
def client(duckdb_conn):
    """
    A TestClient bound to the seeded in-memory database.

    The cache is cleared on both sides of the test: ``lru_cache`` is keyed on session key and
    options, not on the database, so a payload computed against one test's fixture would
    otherwise be served to the next.
    """
    clear_cache()
    with TestClient(app) as test_client:
        yield test_client
    clear_cache()


def _get(client, session_key="2024_01_R", **params):
    response = client.get(f"/api/sessions/{session_key}/tyre-degradation", params=params)
    assert response.status_code == 200, response.text
    return response.json()


# ── Happy path ─────────────────────────────────────────────────────────

def test_returns_fitted_stints_for_a_seeded_session(client):
    payload = _get(client)

    assert payload["session_key"] == "2024_01_R"
    assert payload["circuit_name"] == "Testville"
    assert len(payload["stints"]) == 2

    stint = payload["stints"][0]
    assert stint["driver"] == "CLN"
    assert stint["model"] in {"linear", "quadratic"}
    assert len(stint["params"]) == len(stint["param_names"])
    assert stint["degradation"]["window_source"] in {"nominal", "observed"}


def test_full_detail_embeds_laps_and_curve(client):
    stint = _get(client, detail="full")["stints"][0]

    assert "laps" in stint and "curve" in stint
    assert len(stint["laps"]) == stint["n_laps_total"]
    assert {"lap_number", "tyre_life", "lap_time", "lap_time_corrected", "is_outlier"} <= set(
        stint["laps"][0]
    )
    assert {"tyre_life", "fit", "lo", "hi"} <= set(stint["curve"][0])


def test_summary_detail_omits_laps_and_curve(client):
    """
    The panel's request must stay cheap: no per-lap points, no curve grid, no bootstrap.
    """
    payload = _get(client, detail="summary")
    stint = payload["stints"][0]

    assert "laps" not in stint
    assert "curve" not in stint
    assert payload["config"]["bootstrap_iterations"] == 0
    # The degradation figures the panel actually renders are still present.
    assert stint["degradation"]["s_per_lap"] is not None
    assert payload["compound_summary"]


def test_compound_summary_reports_window_sources(client):
    """A summary must never hide which measurement basis it pooled."""
    for entry in _get(client)["compound_summary"]:
        assert "window_sources" in entry
        assert entry["n_stints_comparable"] <= entry["n_stints"]


# ── Filters ────────────────────────────────────────────────────────────

def test_driver_filter_accepts_abbreviation_or_number(client):
    by_abbrev = _get(client, driver="CLN")
    by_number = _get(client, driver="11")
    assert len(by_abbrev["stints"]) == len(by_number["stints"]) == 2


def test_compound_filter_narrows_stints(client):
    payload = _get(client, compound="HARD")
    assert {s["compound"] for s in payload["stints"]} == {"HARD"}


def test_min_laps_can_exclude_every_stint(client):
    payload = _get(client, min_laps=30)
    assert payload["stints"] == []
    assert payload["warnings"]


# ── Corrections ────────────────────────────────────────────────────────

def test_corrections_are_echoed_back(client):
    config = _get(client)["config"]
    assert [c["name"] for c in config["corrections_applied"]] == ["fuel"]
    assert config["corrections_applied"][0]["keyed_on"] == "lap_number"


def test_empty_corrections_parameter_disables_all_corrections(client):
    """
    ``?corrections=`` is meaningfully different from omitting the parameter: it turns every
    correction off, so a caller can compare corrected against raw lap times.
    """
    payload = _get(client, corrections="")
    assert payload["config"]["corrections_applied"] == []

    stint = payload["stints"][0]
    raw = [lap["lap_time"] for lap in stint["laps"]]
    corrected = [lap["lap_time_corrected"] for lap in stint["laps"]]
    assert raw == corrected


def test_requesting_track_temp_reports_it_skipped_with_a_reason(client):
    """The inert hook must be visible in the response, not silently absent."""
    config = _get(client, corrections="fuel,track_temp")["config"]
    skipped = {s["name"]: s["reason"] for s in config["corrections_skipped"]}
    assert "track_temp" in skipped
    assert "weather=False" in skipped["track_temp"]


# ── Validation and errors ──────────────────────────────────────────────

def test_unknown_session_returns_404(client):
    response = client.get("/api/sessions/1999_99_R/tyre-degradation")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_unknown_correction_returns_400_naming_the_valid_options(client):
    response = client.get(
        "/api/sessions/2024_01_R/tyre-degradation", params={"corrections": "nonsense"}
    )
    assert response.status_code == 400
    assert "nonsense" in response.json()["detail"]
    assert "fuel" in response.json()["detail"]


def test_unknown_model_returns_400(client):
    response = client.get(
        "/api/sessions/2024_01_R/tyre-degradation", params={"models": "cubic"}
    )
    assert response.status_code == 400
    assert "cubic" in response.json()["detail"]


def test_out_of_range_min_laps_is_rejected_by_validation(client):
    assert client.get(
        "/api/sessions/2024_01_R/tyre-degradation", params={"min_laps": 1}
    ).status_code == 422
    assert client.get(
        "/api/sessions/2024_01_R/tyre-degradation", params={"detail": "verbose"}
    ).status_code == 422


# ── Session with no usable data ────────────────────────────────────────

def test_session_with_no_clean_laps_returns_an_empty_payload_not_an_error(client):
    """
    A qualifying session whose laps are all excluded must degrade to an explained empty
    result, so the panel can say why instead of showing an error.
    """
    payload = _get(client, session_key="2024_01_Q", min_laps=30)
    assert payload["stints"] == []
    assert payload["warnings"]


# ── Catalogue registration ─────────────────────────────────────────────

def test_panel_is_registered_in_the_catalogue(client):
    """
    The panel id must match the frontend directory and registerPanel id, or the catalogue
    drawer offers a panel the dashboard cannot render.
    """
    catalogue = client.get("/api/panels").json()
    entry = next(p for p in catalogue if p["id"] == "tyre-degradation")
    assert entry["category"] == "strategy"
    assert {"title", "description", "defaultSize", "minSize"} <= set(entry)
