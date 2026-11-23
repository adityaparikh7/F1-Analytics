"""
F1 Pitwall — OpenF1 fallback source for session ingestion

Since October 2026 the F1 live-timing API requires an F1TV login, so FastF1 can still resolve
the event schedule and session metadata but no longer loads lap timing without one. OpenF1
(https://openf1.org) serves the same timing feed for historical sessions without auth.

`OpenF1Session` wraps a (partially loaded) FastF1 session and exposes `.laps` and `.results`
shaped like FastF1's, so `ingest._store_*` work on it unchanged. Race/Sprint classification
comes from Jolpica (grid, status and retirement order), falling back to OpenF1's own result.
"""

from __future__ import annotations

import logging
import time

import pandas as pd
import requests
from fastf1.ergast.interface import BASE_URL as ERGAST_BASE_URL

logger = logging.getLogger(__name__)

OPENF1_BASE_URL = "https://api.openf1.org/v1"

# FastF1 TrackStatus codes: 1 green, 2 yellow, 4 SC, 5 red, 6 VSC deployed, 7 VSC ending
_GREEN, _SC, _RED, _VSC, _VSC_ENDING = "1", "4", "5", "6", "7"


def _get(endpoint: str, **params) -> list[dict]:
    """GET an OpenF1 endpoint, retrying on rate limiting. 'No results found' maps to []."""
    url = f"{OPENF1_BASE_URL}/{endpoint}"
    for attempt in range(4):
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else []
    resp.raise_for_status()
    return []


def _find_session_key(year: int, session_start) -> int:
    """OpenF1 session_key whose start time is closest to the FastF1 session's (UTC) start."""
    target = pd.Timestamp(session_start)
    target = target.tz_localize("UTC") if target.tzinfo is None else target.tz_convert("UTC")
    sessions = _get("sessions", year=year)
    if not sessions:
        raise ValueError(f"OpenF1 has no sessions for {year}")
    best = min(sessions, key=lambda s: abs(pd.Timestamp(s["date_start"]) - target))
    if abs(pd.Timestamp(best["date_start"]) - target) > pd.Timedelta(hours=6):
        raise ValueError(f"OpenF1 has no session starting near {target}")
    return int(best["session_key"])


def _seconds(value) -> pd.Timedelta:
    return pd.to_timedelta(value, unit="s") if value is not None and not pd.isna(value) else pd.NaT


class OpenF1Session:
    """FastF1-session lookalike backed by OpenF1 timing data.

    `event`, `name` and `date` come from the wrapped FastF1 session (the schedule needs no auth).
    """

    def __init__(self, ff1_session, year: int, session_type: str):
        self.event = ff1_session.event
        self.name = ff1_session.name
        self.date = ff1_session.date
        self._session_type = session_type
        self._year = year
        self._round = int(ff1_session.event["RoundNumber"])

        self.session_key = _find_session_key(self._year, ff1_session.date)
        logger.info("Loading %s from OpenF1 (session_key=%s)", ff1_session.name, self.session_key)

        self._drivers = {d["driver_number"]: d for d in _get("drivers", session_key=self.session_key)}
        self.laps = self._build_laps()
        self.results = self._build_results()
        self.total_laps = int(self.laps["LapNumber"].max()) if not self.laps.empty else None

    # ── Laps ───────────────────────────────────────────────────────────

    def _build_laps(self) -> pd.DataFrame:
        raw = pd.DataFrame(_get("laps", session_key=self.session_key))
        if raw.empty:
            return pd.DataFrame()

        raw = raw.sort_values(["driver_number", "lap_number"]).reset_index(drop=True)
        raw["start"] = pd.to_datetime(raw["date_start"], utc=True, format="ISO8601")
        # A lap ends where the next one starts; the final lap ends after its own duration.
        raw["end"] = raw.groupby("driver_number")["start"].shift(-1)
        raw["end"] = raw["end"].fillna(raw["start"] + pd.to_timedelta(raw["lap_duration"], unit="s"))

        laps = pd.DataFrame({
            "Driver": raw["driver_number"].map(lambda n: self._drivers.get(n, {}).get("name_acronym", str(n))),
            "DriverNumber": raw["driver_number"].astype(str),
            "Team": raw["driver_number"].map(lambda n: self._drivers.get(n, {}).get("team_name")),
            "LapNumber": raw["lap_number"].astype(int),
            "LapTime": raw["lap_duration"].map(_seconds),
            "Sector1Time": raw["duration_sector_1"].map(_seconds),
            "Sector2Time": raw["duration_sector_2"].map(_seconds),
            "Sector3Time": raw["duration_sector_3"].map(_seconds),
        })

        # Lap 1 is flagged as an out-lap for the whole grid; only later out-laps follow a stop.
        pit_out = raw["is_pit_out_lap"].fillna(False).astype(bool) & (raw["lap_number"] > 1)
        pit_in = pit_out.groupby(raw["driver_number"]).shift(-1, fill_value=False).astype(bool)
        laps["PitOutTime"] = raw["start"].where(pit_out)
        laps["PitInTime"] = raw["end"].where(pit_in)

        self._add_stints(laps)
        laps["IsPersonalBest"] = self._personal_bests(laps, pit_in | pit_out)
        laps["TrackStatus"] = self._track_status(raw["start"], raw["end"])
        laps["Position"] = self._positions(raw)
        return laps

    def _add_stints(self, laps: pd.DataFrame) -> None:
        laps["Compound"] = None
        laps["TyreLife"] = pd.NA
        laps["Stint"] = pd.NA
        for st in _get("stints", session_key=self.session_key):
            if st.get("lap_start") is None:
                continue
            lap_end = st.get("lap_end") or laps["LapNumber"].max()
            mask = (
                (laps["DriverNumber"] == str(st["driver_number"]))
                & laps["LapNumber"].between(st["lap_start"], lap_end)
            )
            laps.loc[mask, "Compound"] = st.get("compound")
            laps.loc[mask, "Stint"] = st["stint_number"]
            age = st.get("tyre_age_at_start") or 0
            laps.loc[mask, "TyreLife"] = age + laps.loc[mask, "LapNumber"] - st["lap_start"] + 1

    @staticmethod
    def _personal_bests(laps: pd.DataFrame, pit_lap: pd.Series) -> pd.Series:
        """True where a lap was the driver's fastest so far (in/out laps never count)."""
        times = laps["LapTime"].dt.total_seconds().where(~pit_lap)
        best_so_far = times.groupby(laps["DriverNumber"]).cummin()
        return times.notna() & (times == best_so_far)

    def _track_status(self, starts: pd.Series, ends: pd.Series) -> pd.Series:
        """Per-lap FastF1-style status string: every status code active during the lap, in order."""
        changes: list[tuple[pd.Timestamp, str]] = []
        current = _GREEN
        for msg in sorted(_get("race_control", session_key=self.session_key), key=lambda m: m["date"]):
            text = (msg.get("message") or "").upper()
            flag = (msg.get("flag") or "").upper()
            new = None
            if flag == "RED" or "SESSION ABORTED" in text or "SESSION SUSPENDED" in text:
                new = _RED
            elif "VSC DEPLOYED" in text or "VIRTUAL SAFETY CAR DEPLOYED" in text:
                new = _VSC
            elif "VSC ENDING" in text or "VIRTUAL SAFETY CAR ENDING" in text:
                new = _VSC_ENDING
            elif "SAFETY CAR DEPLOYED" in text:
                new = _SC
            elif current == _RED and "SESSION STARTED" in text:
                new = _GREEN
            elif current != _RED and (flag in ("GREEN", "CLEAR") and msg.get("scope") == "Track"):
                new = _GREEN
            if new is not None and new != current:
                current = new
                changes.append((pd.Timestamp(msg["date"]), new))

        if not changes:
            return pd.Series(_GREEN, index=starts.index)

        times = pd.Series([t for t, _ in changes])
        codes = [c for _, c in changes]
        out = []
        for start, end in zip(starts, ends):
            before = times[times <= start]
            seq = [codes[before.index[-1]] if len(before) else _GREEN]
            seq += [codes[i] for i in times[(times > start) & (times < end)].index]
            out.append("".join(dict.fromkeys(seq)))
        return pd.Series(out, index=starts.index)

    def _positions(self, raw: pd.DataFrame) -> pd.Series:
        """Running position at the end of each lap, from OpenF1's position-change feed."""
        pos = pd.DataFrame(_get("position", session_key=self.session_key))
        if pos.empty:
            return pd.Series(pd.NA, index=raw.index)
        pos["date"] = pd.to_datetime(pos["date"], utc=True, format="ISO8601")
        left = raw[["driver_number", "end"]].reset_index().dropna(subset=["end"]).sort_values("end")
        merged = pd.merge_asof(
            left, pos.sort_values("date")[["driver_number", "date", "position"]],
            left_on="end", right_on="date", by="driver_number", direction="backward",
        )
        return merged.set_index("index")["position"].reindex(raw.index)

    # ── Results ────────────────────────────────────────────────────────

    def _build_results(self) -> pd.DataFrame:
        base = pd.DataFrame([
            {
                "DriverNumber": str(n),
                "Abbreviation": d.get("name_acronym"),
                "TeamName": d.get("team_name"),
            }
            for n, d in self._drivers.items()
        ])
        if base.empty:
            return base

        if self._session_type in ("R", "S"):
            classification = self._jolpica_classification() or self._openf1_classification()
        elif self._session_type in ("Q", "SQ", "SS"):
            classification = self._openf1_qualifying()
        else:
            classification = {}  # practice results are derived from laps by the ingest pipeline

        extra = pd.DataFrame.from_dict(classification, orient="index")
        if extra.empty:
            return base
        extra.index = extra.index.astype(str)
        df = base.join(extra, on="DriverNumber")
        return df.sort_values("Position", na_position="last").reset_index(drop=True)

    def _jolpica_classification(self) -> dict[str, dict]:
        endpoint = "results" if self._session_type == "R" else "sprint"
        url = f"{ERGAST_BASE_URL}/{self._year}/{self._round}/{endpoint}.json"
        try:
            resp = requests.get(url, timeout=20)
            resp.raise_for_status()
            races = resp.json()["MRData"]["RaceTable"]["Races"]
        except Exception as exc:
            logger.warning("Jolpica classification unavailable (%s): %s", url, exc)
            return {}
        rows = (races[0].get("Results") or races[0].get("SprintResults") or []) if races else []
        if not rows:
            return {}

        leader_ms = next((float(r["Time"]["millis"]) for r in rows if r.get("position") == "1" and "Time" in r), None)
        out = {}
        for r in rows:
            ms = float(r["Time"]["millis"]) if "Time" in r else None
            # FastF1 convention: P1's Time is the race duration, everyone else's is the gap to P1.
            if ms is None or leader_ms is None:
                t = pd.NaT
            elif r["position"] == "1":
                t = pd.to_timedelta(ms, unit="ms")
            else:
                t = pd.to_timedelta(ms - leader_ms, unit="ms")
            out[r["number"]] = {
                "Position": int(r["position"]),
                "GridPosition": int(r["grid"]) if r.get("grid") else None,
                "Status": r.get("status"),
                "Points": float(r.get("points", 0)),
                "Time": t,
            }
        return out

    def _openf1_classification(self) -> dict[str, dict]:
        rows = _get("session_result", session_key=self.session_key)
        if not rows:
            return {}
        classified = [r for r in rows if r.get("position") is not None]
        # Unclassified drivers get the trailing positions, most laps completed first.
        unclassified = sorted((r for r in rows if r.get("position") is None),
                              key=lambda r: -(r.get("number_of_laps") or 0))
        out = {}
        for pos, r in enumerate(sorted(classified, key=lambda r: r["position"]) + unclassified, start=1):
            gap = r.get("gap_to_leader")
            if r.get("dsq"):
                status = "Disqualified"
            elif r.get("dns"):
                status = "Did not start"
            elif r.get("dnf"):
                status = "Retired"
            elif isinstance(gap, str):
                status = "Lapped"
            else:
                status = "Finished"
            if pos == 1:
                t = _seconds(r.get("duration"))
            else:
                t = _seconds(gap) if isinstance(gap, (int, float)) else pd.NaT
            out[str(r["driver_number"])] = {
                "Position": pos,
                "GridPosition": None,
                "Status": status,
                "Points": float(r.get("points") or 0),
                "Time": t,
            }
        return out

    def _openf1_qualifying(self) -> dict[str, dict]:
        out = {}
        for r in _get("session_result", session_key=self.session_key):
            parts = r.get("duration")
            parts = parts if isinstance(parts, list) else [parts]
            parts = (parts + [None, None, None])[:3]
            out[str(r["driver_number"])] = {
                "Position": r.get("position"),
                "Q1": _seconds(parts[0]),
                "Q2": _seconds(parts[1]),
                "Q3": _seconds(parts[2]),
            }
        return out
