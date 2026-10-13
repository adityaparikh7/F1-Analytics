"""
F1 Pitwall — Race Replay API Router

Serves built replays from the on-disk cache, building on first request.

A build loads a whole race with telemetry (seconds from a warm FastF1 cache, minutes on a
first download), so it runs on a single background worker: the event loop stays free, two
requests for the same race share one build, and only one FastF1 session is held in memory
at a time.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from backend.pipeline import replay as replay_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(tags=["replay"])

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="replay-build")
_builds: dict[str, Future] = {}
_builds_lock = threading.Lock()


def _parse_race_key(session_key: str) -> None:
    try:
        year, _, session_type = replay_pipeline.parse_session_key(session_key)
    except ValueError:
        raise HTTPException(400, f"Invalid session_key format: {session_key}")
    if not replay_pipeline.is_race_session(year, session_type):
        raise HTTPException(400, "Replay is only available for races and sprints")


def _forget_build(session_key: str) -> None:
    with _builds_lock:
        _builds.pop(session_key, None)


def _start_build(session_key: str) -> Future | None:
    """Return the in-flight build for this session, starting one if needed (None if cached)."""
    if replay_pipeline.is_cached(session_key):
        return None
    with _builds_lock:
        future = _builds.get(session_key)
        if future is None:
            logger.info("Building replay for %s", session_key)
            future = _executor.submit(replay_pipeline.build_and_cache, session_key)
            _builds[session_key] = future
            future.add_done_callback(lambda _: _forget_build(session_key))
    return future


async def _ensure_built(session_key: str) -> None:
    future = _start_build(session_key)
    if future is None:
        return
    try:
        await asyncio.wrap_future(future)
    except replay_pipeline.ReplayUnavailable as exc:
        raise HTTPException(404, f"No replay available: {exc}")
    except Exception as exc:
        logger.error("Replay build failed for %s: %s", session_key, exc, exc_info=True)
        raise HTTPException(500, f"Failed to build replay: {exc}")


def _gzip_json(path: Path, request: Request) -> Response:
    """
    Serve a pre-gzipped JSON file as-is. Setting ``Content-Encoding`` makes the app's
    GZipMiddleware pass the body through instead of recompressing ~4 MB on every request.
    """
    if "gzip" in request.headers.get("accept-encoding", "").lower():
        return FileResponse(
            path,
            media_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )
    return Response(gzip.decompress(path.read_bytes()), media_type="application/json")


@lru_cache(maxsize=16)
def _driver_numbers(session_key: str, mtime: float) -> dict[str, str]:
    """Abbreviation and number → car number, read once per built replay (``mtime`` keys it)."""
    with gzip.open(replay_pipeline.replay_path(session_key), "rt", encoding="utf-8") as fh:
        payload = json.load(fh)
    index: dict[str, str] = {}
    for drv in payload["drivers"]:
        index[drv["abbr"].upper()] = drv["number"]
        index[drv["number"]] = drv["number"]
    return index


@router.get("/sessions/{session_key}/replay/status")
async def get_replay_status(session_key: str):
    """Whether a replay exists for this session, is already built, or is being built."""
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
            "building": False,
        }
    with _builds_lock:
        building = session_key in _builds
    return {
        "session_key": session_key,
        "available": True,
        "reason": None,
        "cached": replay_pipeline.is_cached(session_key),
        "building": building,
    }


@router.get("/sessions/{session_key}/replay")
async def get_replay(session_key: str, request: Request):
    """
    The replay payload: every car's position and race progress on a uniform grid (delta-encoded
    integers), plus lap, pit stop, track status and race control timelines.

    Built on first request (seconds from a warm FastF1 cache), then served from disk.
    """
    _parse_race_key(session_key)
    await _ensure_built(session_key)
    return _gzip_json(replay_pipeline.replay_path(session_key), request)


@router.get("/sessions/{session_key}/replay/hud")
async def get_replay_hud(
    session_key: str,
    request: Request,
    driver: str = Query(..., min_length=1, max_length=3),
):
    """
    Focused-driver telemetry (speed, throttle, brake, gear, DRS) on the replay grid.

    - `driver`: 3-letter abbreviation (e.g. VER) or car number (e.g. 1)
    """
    _parse_race_key(session_key)
    await _ensure_built(session_key)

    path = replay_pipeline.replay_path(session_key)
    number = _driver_numbers(session_key, path.stat().st_mtime).get(driver.upper())
    hud = replay_pipeline.hud_path(session_key, number) if number else None
    if hud is None or not hud.exists():
        raise HTTPException(404, f"No replay telemetry for driver {driver} in {session_key}")
    return _gzip_json(hud, request)
