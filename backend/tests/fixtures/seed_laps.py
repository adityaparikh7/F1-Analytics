"""
Hand-written lap rows covering every case the clean-lap predicate must handle.

Deliberately small and explicit rather than generated: the point of this fixture is that a
human can read it and verify by eye which rows *should* survive filtering, so the SQL
contract test asserts against an understood expectation rather than against whatever the
query happens to return.

Rows are tuples in ``laps`` column order, which is also the order the positional INSERT in
conftest uses:

    session_key, driver, driver_number, team, lap_number, lap_time,
    sector1_time, sector2_time, sector3_time, compound, tyre_life, stint,
    is_personal_best, is_pit_out_lap, is_pit_in_lap, track_status, position
"""

from __future__ import annotations

#: (session_key, year, round_number, event_name, country, circuit_name, session_type,
#:  date, total_laps)
SEED_SESSIONS: list[tuple] = [
    ("2024_01_R", 2024, 1, "Test Grand Prix", "Testland", "Testville", "R", "2024-03-02", 57),
    ("2024_02_R", 2024, 2, "Other Grand Prix", "Otherland", "Otherton", "R", "2024-03-09", 50),
    ("2018_01_R", 2018, 1, "Legacy Grand Prix", "Legacyland", "Legacytown", "R", "2018-03-25", 58),
    ("2024_01_Q", 2024, 1, "Test Grand Prix", "Testland", "Testville", "Q", "2024-03-01", 0),
]

_TEAM = "Test Team"


def _lap(
    session_key: str,
    driver: str,
    number: int,
    lap_number: int,
    lap_time: float | None,
    compound: str | None,
    tyre_life: int | None,
    stint: int | None,
    track_status: str = "1",
    pit_out: bool = False,
    pit_in: bool = False,
) -> tuple:
    return (
        session_key, driver, number, _TEAM, lap_number, lap_time,
        None, None, None, compound, tyre_life, stint,
        False, pit_out, pit_in, track_status, 1,
    )


def seed_lap_rows() -> list[tuple]:
    """
    Build the seed lap set.

    ``CLEAN`` driver rows are all valid and form two fittable stints. Every other driver
    carries exactly one disqualifying property, so a test failure points straight at which
    clause of the predicate broke.
    """
    rows: list[tuple] = []

    # ── CLEAN: two stints of 10 clean laps each, with a realistic degradation slope.
    #    Stint 1 is laps 1-10 (tyre_life 1-10); stint 2 is laps 11-20 (tyre_life 1-10),
    #    so lap_number keeps counting while tyre_life resets — which is what the fuel
    #    correction test needs in order to catch a stint-relative implementation.
    for stint in (1, 2):
        for age in range(1, 11):
            lap_number = (stint - 1) * 10 + age
            rows.append(
                _lap(
                    "2024_01_R", "CLN", 11, lap_number,
                    lap_time=90.0 + 0.06 * age,
                    compound="MEDIUM" if stint == 1 else "HARD",
                    tyre_life=age,
                    stint=stint,
                )
            )

    # ── Junk compound values. All must be rejected by the whitelist.
    #    'nan' is a real value in the database: ingest.py applies .astype(str) to the
    #    FastF1 column, which stringifies NaN.
    rows.append(_lap("2024_01_R", "NAN", 20, 1, 91.0, "nan", 3, 1))
    rows.append(_lap("2024_01_R", "NUL", 21, 1, 91.0, None, 3, 1))
    rows.append(_lap("2024_01_R", "UNK", 22, 1, 91.0, "UNKNOWN", 3, 1))
    #   Wet compounds are valid strings but excluded from dry-tyre degradation modelling.
    rows.append(_lap("2024_01_R", "INT", 23, 1, 91.0, "INTERMEDIATE", 3, 1))

    # ── Track status. '1' is all-clear; everything else must be rejected.
    #    '14' and '124' are the important ones: they CONTAIN '1', so a substring match
    #    would wrongly keep them.
    rows.append(_lap("2024_01_R", "TS4", 30, 1, 91.0, "SOFT", 3, 1, track_status="4"))
    rows.append(_lap("2024_01_R", "T14", 31, 1, 91.0, "SOFT", 3, 1, track_status="14"))
    rows.append(_lap("2024_01_R", "T24", 32, 1, 91.0, "SOFT", 3, 1, track_status="124"))
    rows.append(_lap("2024_01_R", "TS6", 33, 1, 91.0, "SOFT", 3, 1, track_status="6"))

    # ── Pit laps.
    rows.append(_lap("2024_01_R", "PIO", 40, 1, 110.0, "SOFT", 1, 1, pit_out=True))
    rows.append(_lap("2024_01_R", "PII", 41, 1, 115.0, "SOFT", 9, 1, pit_in=True))

    # ── Null / out-of-range measurements.
    rows.append(_lap("2024_01_R", "NLT", 50, 1, None, "SOFT", 3, 1))
    rows.append(_lap("2024_01_R", "NTL", 51, 1, 91.0, "SOFT", None, 1))
    rows.append(_lap("2024_01_R", "NST", 52, 1, 91.0, "SOFT", 3, None))
    rows.append(_lap("2024_01_R", "LOW", 53, 1, 12.0, "SOFT", 3, 1))      # below LAP_TIME_MIN_S
    rows.append(_lap("2024_01_R", "HIG", 54, 1, 450.0, "SOFT", 3, 1))     # above LAP_TIME_MAX_S

    # ── SHORT: a valid stint with too few laps to fit; tests min_clean_laps.
    for age in range(1, 4):
        rows.append(_lap("2024_01_R", "SHT", 60, age, 92.0 + 0.05 * age, "SOFT", age, 1))

    # ── A second race session, so year/session scoping can be tested.
    for age in range(1, 11):
        rows.append(_lap("2024_02_R", "CLN", 11, age, 95.0 + 0.07 * age, "MEDIUM", age, 1))

    # ── A 2018 session using a legacy compound: allowed in Phase 1, excluded from Phase 2.
    for age in range(1, 11):
        rows.append(_lap("2018_01_R", "LEG", 70, age, 93.0 + 0.05 * age, "ULTRASOFT", age, 1))

    # ── A qualifying session: excluded from pooled training by session type.
    for age in range(1, 11):
        rows.append(_lap("2024_01_Q", "CLN", 11, age, 88.0 + 0.02 * age, "SOFT", age, 1))

    return rows
