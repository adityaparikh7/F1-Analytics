"""
F1 Pitwall — Race Replay weather

Air and track temperature, humidity, pressure, wind and rainfall on the replay's session clock,
plus the periods it rained. Kept as a sidecar beside the replay rather than inside it, because
its availability differs: it works for replays of any version, and when FastF1's cache lacks the
weather stream (most races built before it was ever requested) OpenF1 is asked instead.

Sources, in order:

1. FastF1's disk cache (``weather=True`` load, cache-only like replay builds). Its ``Time`` is
   already session time.
2. OpenF1 ``/weather`` (2023 onwards, no auth). Its UTC timestamps are put on the session clock
   with the replay's ``t0_date``, the same way race-control messages are.

A session neither has is cached as ``{"source": null}`` and asked again after six hours.
"""

from __future__ import annotations

import gzip
import json
import logging
import time
from pathlib import Path

import fastf1
import numpy as np
import pandas as pd

from backend.config import REPLAY_CACHE_DIR
from backend.pipeline import openf1
from backend.pipeline import replay as replay_pipeline
from backend.pipeline import replay_math as rm
from backend.pipeline.fastf1_cache import cache_only

logger = logging.getLogger(__name__)

WEATHER_DIR_NAME = "weather"
#: A miss (no source had weather) is retried after this long.
MISS_RETRY_S = 6 * 3600
#: FastF1's rainfall flag flickers; a shower needs this many consecutive wet samples (~1/min).
RAIN_MIN_SAMPLES = 2


def weather_path(session_key: str) -> Path:
    return REPLAY_CACHE_DIR / WEATHER_DIR_NAME / f"{session_key}.json.gz"


def read_cached(session_key: str) -> dict | None:
    """The cached weather, or None if absent or a miss old enough to try again."""
    path = weather_path(session_key)
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        payload = json.load(fh)
    if payload.get("source") is None and time.time() - payload.get("built_at", 0) > MISS_RETRY_S:
        return None
    return payload


def build_and_cache(session_key: str) -> dict:
    payload = build_weather(session_key)
    replay_pipeline._write_json_gz(weather_path(session_key), payload)
    return payload


def build_weather(session_key: str) -> dict:
    year, rnd, stype = replay_pipeline.parse_session_key(session_key)
    samples, source, session_date = [], None, None

    try:
        with cache_only():
            session = fastf1.get_session(year, rnd, stype)
            session_date = session.date
            session.load(laps=False, telemetry=False, weather=True, messages=False)
            frame = session.weather_data
        samples = _from_fastf1(frame)
        source = "fastf1" if samples else None
    except Exception as exc:
        logger.info("No FastF1 weather for %s: %s", session_key, exc)

    if not samples:
        try:
            samples = _from_openf1(session_key, year, session_date)
            source = "openf1" if samples else None
        except Exception as exc:
            logger.info("No OpenF1 weather for %s: %s", session_key, exc)

    return {
        "session_key": session_key,
        "source": source,
        "built_at": time.time(),
        "samples": samples,
        "rain": rain_periods(samples),
    }


def _from_fastf1(frame: pd.DataFrame | None) -> list[dict]:
    if frame is None or frame.empty:
        return []
    return [
        _sample(
            row["Time"].total_seconds(), row.get("AirTemp"), row.get("TrackTemp"), row.get("Humidity"),
            row.get("Pressure"), row.get("Rainfall"), row.get("WindSpeed"), row.get("WindDirection"),
        )
        for _, row in frame.iterrows()
        if pd.notna(row.get("Time"))
    ]


def _from_openf1(session_key: str, year: int, session_date) -> list[dict]:
    """OpenF1 weather, put on the session clock with the cached replay's ``t0_date``."""
    t0 = _replay_t0(session_key)
    if t0 is None or session_date is None:
        return []
    rows = openf1._get("weather", session_key=openf1._find_session_key(year, session_date))
    out = []
    for r in rows:
        when = pd.Timestamp(r["date"])
        when = when.tz_convert("UTC").tz_localize(None) if when.tzinfo else when
        out.append(_sample(
            (when - t0).total_seconds(), r.get("air_temperature"), r.get("track_temperature"),
            r.get("humidity"), r.get("pressure"), r.get("rainfall"), r.get("wind_speed"),
            r.get("wind_direction"),
        ))
    out.sort(key=lambda s: s["t"])
    return out


def _replay_t0(session_key: str) -> pd.Timestamp | None:
    version = replay_pipeline.newest_cached_version(session_key)
    payload = replay_pipeline.read_replay(session_key, version) if version else None
    t0 = payload.get("t0_date") if payload else None
    return pd.Timestamp(t0) if t0 else None


def _num(v, nd: int = 1) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if np.isfinite(f) else None


def _sample(t, air, track, humidity, pressure, rain, wind_speed, wind_dir) -> dict:
    return {
        "t": round(float(t), 1),
        "air": _num(air),
        "track": _num(track),
        "humidity": _num(humidity, 0),
        "pressure": _num(pressure),
        "rain": bool(rain) if rain is not None and not (isinstance(rain, float) and np.isnan(rain)) else False,
        "wind_speed": _num(wind_speed),
        "wind_dir": _num(wind_dir, 0),
    }


def rain_periods(samples: list[dict]) -> list[list[float]]:
    """``[[start_t, end_t], ...]`` for runs of at least ``RAIN_MIN_SAMPLES`` wet samples."""
    if not samples:
        return []
    t = np.array([s["t"] for s in samples], dtype=float)
    wet = np.array([s["rain"] for s in samples], dtype=bool)
    return rm.rain_periods(t, wet, RAIN_MIN_SAMPLES)
