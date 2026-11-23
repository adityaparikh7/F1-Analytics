"""
F1 Pitwall — Race Replay API Router

Serves built replays from the on-disk cache, building on first request.

A build loads a whole race with telemetry (seconds from the FastF1 cache), so it runs on a single
background worker: the event loop stays free, two requests for the same race share one build, and
only one FastF1 session is held in memory at a time.

Replays are versioned (see ``backend.pipeline.replay``). The newest cached version is served. If
that is an older version, it is served straight away and an upgrade build is started behind it;
the next visit gets the new version. An upgrade that fails (typically: the race is no longer in
the FastF1 cache, and FastF1 now needs an F1TV login to fetch it) is not retried for six hours,
and the older replay keeps being served.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from backend.pipeline import replay as replay_pipeline
from backend.pipeline import replay_weather

logger = logging.getLogger(__name__)

router = APIRouter(tags=["replay"])

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="replay-build")
_builds: dict[str, Future] = {}
_failures: dict[str, float] = {}
_builds_lock = threading.Lock()

#: How long a failed upgrade build is remembered before it is tried again.
UPGRADE_RETRY_S = 6 * 3600


def _parse_race_key(session_key: str) -> None:
    try:
        year, _, session_type = replay_pipeline.parse_session_key(session_key)
    except ValueError:
        raise HTTPException(400, f"Invalid session_key format: {session_key}")
    if not replay_pipeline.is_race_session(year, session_type):
        raise HTTPException(400, "Replay is only available for races and sprints")


def _build_done(session_key: str, future: Future) -> None:
    with _builds_lock:
        _builds.pop(session_key, None)
        if future.exception() is not None:
            _failures[session_key] = time.monotonic()
        else:
            _failures.pop(session_key, None)


def _start_build(session_key: str) -> Future | None:
    """
    The in-flight build of the current version for this session, starting one if needed.
    None when the current version is already cached.
    """
    if replay_pipeline.is_cached(session_key):
        return None
    with _builds_lock:
        future = _builds.get(session_key)
        if future is None:
            logger.info("Building v%d replay for %s", replay_pipeline.REPLAY_VERSION, session_key)
            future = _executor.submit(replay_pipeline.build_and_cache, session_key)
            _builds[session_key] = future
            future.add_done_callback(lambda f: _build_done(session_key, f))
    return future


def _upgrade_recently_failed(session_key: str) -> bool:
    with _builds_lock:
        failed_at = _failures.get(session_key)
    return failed_at is not None and time.monotonic() - failed_at < UPGRADE_RETRY_S


async def _servable_version(session_key: str) -> int:
    """
    The version to serve now. An older cached version is served immediately (with an upgrade
    build started behind it); with nothing cached, build the current version and wait.
    """
    cached = replay_pipeline.newest_cached_version(session_key)
    if cached == replay_pipeline.REPLAY_VERSION:
        return cached
    if cached is not None:
        if not _upgrade_recently_failed(session_key):
            _start_build(session_key)
        return cached

    future = _start_build(session_key)
    if future is not None:
        try:
            await asyncio.wrap_future(future)
        except replay_pipeline.ReplayUnavailable as exc:
            raise HTTPException(404, f"No replay available: {exc}")
        except Exception as exc:
            logger.error("Replay build failed for %s: %s", session_key, exc, exc_info=True)
            raise HTTPException(500, f"Failed to build replay: {exc}")
    return replay_pipeline.REPLAY_VERSION


def _gzip_json(path: Path, request: Request) -> Response:
    """
    Serve a pre-gzipped JSON file as-is. Setting ``Content-Encoding`` makes the app's
    GZipMiddleware pass the body through instead of recompressing ~4 MB on every request.

    ``no-cache`` because the same URL changes content when a replay is upgraded to a newer
    version; without it the browser's heuristic caching keeps serving the old file for days.
    """
    if "gzip" in request.headers.get("accept-encoding", "").lower():
        return FileResponse(
            path,
            media_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding", "Cache-Control": "no-cache"},
        )
    return Response(
        gzip.decompress(path.read_bytes()), media_type="application/json", headers={"Cache-Control": "no-cache"}
    )


@lru_cache(maxsize=16)
def _driver_numbers(session_key: str, version: int, mtime: float) -> dict[str, str]:
    """Abbreviation and number → car number, read once per built replay (``mtime`` keys it)."""
    with gzip.open(replay_pipeline.replay_path(session_key, version), "rt", encoding="utf-8") as fh:
        payload = json.load(fh)
    index: dict[str, str] = {}
    for drv in payload["drivers"]:
        index[drv["abbr"].upper()] = drv["number"]
        index[drv["number"]] = drv["number"]
    return index


@router.get("/sessions/{session_key}/replay/status")
async def get_replay_status(session_key: str):
    """
    Whether a replay exists for this session, which version is cached, and whether a build (or
    an upgrade of an older cached version) is running.
    """
    try:
        year, _, session_type = replay_pipeline.parse_session_key(session_key)
    except ValueError:
        raise HTTPException(400, f"Invalid session_key format: {session_key}")

    if not replay_pipeline.is_race_session(year, session_type):
        return {
            "session_key": session_key,
            "available": False,
            "reason": "Replay is only available for races and sprints",
            "cached": False,
            "version": None,
            "building": False,
            "upgrading": False,
        }
    version = replay_pipeline.newest_cached_version(session_key)
    with _builds_lock:
        building = session_key in _builds
    return {
        "session_key": session_key,
        "available": True,
        "reason": None,
        "cached": version is not None,
        "version": version,
        "building": building,
        "upgrading": building and version is not None,
    }


@router.get("/sessions/{session_key}/replay")
async def get_replay(session_key: str, request: Request):
    """
    The replay payload: every car's position and race progress on a uniform grid (delta-encoded
    integers), plus lap, pit stop, track status and race control timelines.

    Built on first request (seconds from the FastF1 cache), then served from disk. The payload's
    ``version`` says which version was served; pass it as ``v`` to ``/replay/hud``.
    """
    _parse_race_key(session_key)
    version = await _servable_version(session_key)
    return _gzip_json(replay_pipeline.replay_path(session_key, version), request)


@router.get("/sessions/{session_key}/replay/weather")
async def get_replay_weather(session_key: str):
    """
    Weather on the replay's session clock: ``samples`` (~1/min: air and track temperature,
    humidity, pressure, wind, rainfall) and ``rain`` periods. ``source`` is ``fastf1``,
    ``openf1`` or null when neither had data for this session.
    """
    _parse_race_key(session_key)
    cached = replay_weather.read_cached(session_key)
    if cached is not None:
        return cached

    job = f"weather:{session_key}"
    with _builds_lock:
        future = _builds.get(job)
        if future is None:
            future = _executor.submit(replay_weather.build_and_cache, session_key)
            _builds[job] = future
            future.add_done_callback(lambda f: _build_done(job, f))
    try:
        return await asyncio.wrap_future(future)
    except Exception as exc:
        logger.error("Weather build failed for %s: %s", session_key, exc, exc_info=True)
        raise HTTPException(500, f"Failed to load weather: {exc}")


@router.get("/sessions/{session_key}/replay/hud")
async def get_replay_hud(
    session_key: str,
    request: Request,
    driver: str = Query(..., min_length=1, max_length=3),
    v: int | None = Query(None, description="Replay version the client loaded (its timing grid)"),
):
    """
    Focused-driver telemetry (speed, RPM, throttle, brake, gear, DRS) on the replay grid.

    - `driver`: 3-letter abbreviation (e.g. VER) or car number (e.g. 1)
    - `v`: the replay version the client is showing, so the HUD matches its frames
    """
    _parse_race_key(session_key)
    if v is not None and replay_pipeline.is_cached(session_key, v):
        version = v
    else:
        version = await _servable_version(session_key)

    path = replay_pipeline.replay_path(session_key, version)
    number = _driver_numbers(session_key, version, path.stat().st_mtime).get(driver.upper())
    hud = replay_pipeline.hud_path(session_key, number, version) if number else None
    if hud is None or not hud.exists():
        raise HTTPException(404, f"No replay telemetry for driver {driver} in {session_key}")
    return _gzip_json(hud, request)
