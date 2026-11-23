"""
F1 Pitwall — FastF1 cache access

Since FastF1 3.9 (Oct 2026), live-timing requests need an F1TV login. Responses already in
FastF1's disk cache still load without one, so replay builds read **only** from the cache: a race
whose data is cached builds offline, and one that isn't fails fast instead of trying the network
without credentials (and risking an error body replacing a good cached response).

FastF1's offline mode is a global on its shared HTTP session, so anything else that loads FastF1
data (ingest, telemetry routes) takes the same lock: it must never run while a build has the
session switched offline. Set ``REPLAY_FASTF1_ONLINE=1`` when F1TV credentials are configured to
let builds use the network again.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager

import fastf1

from backend.config import REPLAY_FASTF1_ONLINE

#: Held around every FastF1 load. Re-entrant so a helper can take it inside a caller that has it.
FASTF1_LOCK = threading.RLock()


@contextmanager
def cache_only() -> Iterator[None]:
    """Load FastF1 data from the disk cache only, for the duration of the block."""
    with FASTF1_LOCK:
        if REPLAY_FASTF1_ONLINE:
            yield
            return
        settings = _session_settings()
        previous = settings.only_if_cached
        fastf1.Cache.offline_mode(True)
        try:
            yield
        finally:
            fastf1.Cache.offline_mode(previous)


def _session_settings():
    """
    FastF1's cached HTTP session settings. The project cache is configured first: configuring it
    replaces the session, and without it FastF1 would fall back to its default cache location.
    """
    from backend.pipeline.ingest import _init_fastf1

    _init_fastf1()
    if fastf1.Cache._requests_session_cached is None:
        fastf1.Cache._ensure_caching()
    return fastf1.Cache._requests_session_cached.settings
