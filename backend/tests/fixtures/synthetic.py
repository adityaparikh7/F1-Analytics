"""
Synthetic stint generators.

Everything here is seeded and offline — no FastF1, no network, no cache. The point is to
build stints whose true degradation is *known*, so a test can assert that the fitting code
recovers it rather than merely asserting it returns something.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def make_stint(
    n_laps: int = 15,
    l0: float = 90.0,
    deg: float = 0.06,
    curvature: float = 0.0,
    noise: float = 0.1,
    outliers: tuple[tuple[int, float], ...] = (),
    tyre_life_start: int = 1,
    lap_number_start: int = 1,
    compound: str = "MEDIUM",
    driver: str = "TST",
    stint: int = 1,
    session_key: str = "2024_01_R",
    seed: int = 0,
) -> pd.DataFrame:
    """
    One stint with a known degradation rate.

    ``lap_time = l0 + deg*age + curvature*age^2 + noise``, where ``age`` is tyre life.

    *outliers* is a sequence of ``(index, delta_seconds)`` injected after noise, for testing
    that robust fitting and MAD filtering survive them.

    *lap_number_start* is separate from *tyre_life_start* on purpose: the fuel correction
    keys on absolute lap number, so tests need stints where the two diverge.
    """
    rng = np.random.default_rng(seed)
    age = np.arange(tyre_life_start, tyre_life_start + n_laps, dtype=float)
    lap_time = l0 + deg * age + curvature * age**2 + rng.normal(0.0, noise, n_laps)

    for index, delta in outliers:
        lap_time[index] += delta

    return pd.DataFrame(
        {
            "session_key": session_key,
            "driver": driver,
            "driver_number": 1,
            "team": "Test Team",
            "lap_number": np.arange(lap_number_start, lap_number_start + n_laps),
            "lap_time": lap_time,
            "compound": compound,
            "tyre_life": age.astype(int),
            "stint": stint,
        }
    )


def make_two_stint_race(
    n_laps: int = 10,
    seed: int = 0,
) -> pd.DataFrame:
    """
    A two-stint race where ``lap_number`` runs continuously while ``tyre_life`` resets.

    This is the shape that distinguishes a correct fuel correction from the stint-relative
    one in the local analytics script: the correction must be monotone across the pit stop,
    whereas a stint-relative implementation saw-tooths back down at the stop.
    """
    first = make_stint(
        n_laps=n_laps, tyre_life_start=1, lap_number_start=1,
        compound="MEDIUM", stint=1, seed=seed,
    )
    second = make_stint(
        n_laps=n_laps, tyre_life_start=1, lap_number_start=n_laps + 1,
        compound="HARD", stint=2, seed=seed + 1,
    )
    return pd.concat([first, second], ignore_index=True)


def make_session(
    n_drivers: int = 4,
    n_stints: int = 2,
    n_laps: int = 15,
    circuit: str = "Testville",
    session_key: str = "2024_01_R",
    year: int = 2024,
    base_lap_time: float = 90.0,
    seed: int = 0,
) -> pd.DataFrame:
    """
    A full synthetic session, shaped like :func:`backend.db.queries.get_clean_stint_laps`
    output — including ``session_median_lap_time`` and ``clean_lap_count``.
    """
    rng = np.random.default_rng(seed)
    compounds = ("SOFT", "MEDIUM", "HARD")
    frames = []

    for d in range(n_drivers):
        driver = f"D{d:02d}"
        driver_pace = base_lap_time + rng.normal(0.0, 0.4)
        lap_cursor = 1
        for s in range(1, n_stints + 1):
            compound = compounds[(d + s) % len(compounds)]
            frame = make_stint(
                n_laps=n_laps,
                l0=driver_pace,
                deg=0.04 + 0.02 * ((d + s) % 3),
                tyre_life_start=1,
                lap_number_start=lap_cursor,
                compound=compound,
                driver=driver,
                stint=s,
                session_key=session_key,
                seed=seed + d * 10 + s,
            )
            frames.append(frame)
            lap_cursor += n_laps

    laps = pd.concat(frames, ignore_index=True)
    laps["year"] = year
    laps["circuit_name"] = circuit
    laps["event_name"] = "Test Grand Prix"
    laps["session_type"] = "R"
    laps["session_median_lap_time"] = laps["lap_time"].median()
    laps["clean_lap_count"] = laps.groupby(["driver", "stint"])["lap_time"].transform("size")
    return laps


def make_multi_race(
    n_races: int = 6,
    n_drivers: int = 4,
    seed: int = 0,
) -> pd.DataFrame:
    """
    Several synthetic races across distinct circuits, for pooled-model and CV tests.

    Circuits differ in both lap-time scale and degradation severity, so a pooled model has
    real structure to recover and held-out-race CV has something to measure.
    """
    frames = []
    for r in range(n_races):
        frames.append(
            make_session(
                n_drivers=n_drivers,
                circuit=f"Circuit{r % 3}",
                session_key=f"2024_{r + 1:02d}_R",
                base_lap_time=80.0 + 10.0 * (r % 3),
                seed=seed + r * 100,
            )
        )
    return pd.concat(frames, ignore_index=True)
