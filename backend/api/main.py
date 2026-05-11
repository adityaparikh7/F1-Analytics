"""
F1 Pitwall — FastAPI Application Entry Point

Configures CORS, lifespan events, and mounts all routers.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from backend.config import CORS_ORIGINS, LOG_LEVEL
from backend.db.connection import close_connection
from backend.db.schema import initialise_schema

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup
    logger.info("F1 Pitwall backend starting up")
    initialise_schema()
    logger.info("Schema initialised")
    yield
    # Shutdown
    close_connection()
    logger.info("F1 Pitwall backend shut down")


app = FastAPI(
    title="F1 Pitwall API",
    description="Formula One analytics dashboard backend",
    version="0.1.0",
    lifespan=lifespan,
)

# ── Middleware ──────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# ── Routers ────────────────────────────────────────────────────────────
from backend.api.sessions import router as sessions_router  # noqa: E402
from backend.api.standings import router as standings_router  # noqa: E402
from backend.api.telemetry import router as telemetry_router  # noqa: E402
from backend.api.panels import router as panels_router  # noqa: E402

app.include_router(sessions_router, prefix="/api")
app.include_router(standings_router, prefix="/api")
app.include_router(telemetry_router, prefix="/api")
app.include_router(panels_router, prefix="/api")


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "f1-pitwall"}
