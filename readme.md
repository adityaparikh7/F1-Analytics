# F1 Pitwall

A local-first Formula 1 analytics platform. A data pipeline pulls timing data from [FastF1](https://github.com/theOehrly/Fast-F1), normalises it into Parquet and a DuckDB feature store, and a FastAPI backend serves it to a React dashboard of draggable, resizable panels. Dedicated pages go deeper on race pace, telemetry, tyre degradation, team radio and the championship fight.

## Architecture

```
FastF1 ──► pipeline/ingest.py ──► Parquet (data/parquet/) ──► DuckDB (data/pitwall.duckdb)
                                                                    │
                                                           FastAPI  /api  (backend/)
                                                                    │
                                                  React dashboard + pages  (frontend/)
```

Design decisions worth knowing before you change anything:

*   **The frontend only talks to `/api`.** It never reads Parquet or DuckDB directly.
*   **Telemetry is on-demand.** Laps, stints, results and the calendar are ingested eagerly; telemetry is pulled live from FastF1 per request (and then cached by FastF1) to avoid storing huge datasets.
*   **Standings are computed, not stored.** Driver and constructor standings are SQL aggregations over the `results` table.
*   **Everything resolves from the project root** via `backend/config.py` and can be overridden with environment variables (see [Configuration](#configuration)). Seasons before 2018 are rejected by the ingestion endpoints.

## Features

### Dashboard

A react-grid-layout grid of **18 panels**. Add panels from the catalogue drawer (`⌘K`), drag and resize them, and save named layouts (kept in `localStorage`). Panels are glanceable summaries; the depth lives on the pages below.

| Category | Panels |
|----------|--------|
| Session | Session Results, Season Calendar, Driver Standings, Constructor Standings, Championship Battle, Track Map, Race Control Messages, Team Radio |
| Telemetry | Telemetry Explorer, Driving Phases Plot, Qualifying Comparison, Aero Map |
| Performance | Lap Time Distribution, Lap Time Progression, Top Speed Plot, Position Changes |
| Strategy | Strategy Board, Tyre Degradation |

A `speed-trace` panel exists in the source but is currently disabled.

### Deep-dive pages

| Route | What it shows |
|-------|---------------|
| `/race-pace` | Driver and team pace box plots, ranking tables, compound-coloured laps, 107% and finishers-only filters |
| `/telemetry` | Two-driver head-to-head: track map with dominance colouring, time delta, speed / throttle / brake / gear traces, corner annotations, animated lap playback |
| `/team-radio` | The session's team radio clips with a per-driver filter and audio playback |
| `/tyre-degradation` | Fitted degradation curves with 95% bands, per-stint model selection, compound comparison, and which corrections were and were not applied |
| `/championship` | Title odds, season trajectory with a projected fan, who can still win, what-if scenarios, and the model's method and caveats |

### Modelling (`backend/ml/`)

*   **Tyre degradation** — per-stint fits on fuel-corrected clean laps. Linear and quadratic models are compared by AICc, degradation is reported as a model-agnostic s/lap over a tyre-life window, with a bootstrap confidence band, cliff detection and a cross-stint anomaly score.
*   **Championship projection** — a Monte Carlo form model that gives each driver's title odds, who can still mathematically win, and the effect of pinning results in sessions still to run. Its spread parameters were backtested against the 2018–2025 champions.

Not built yet: the pooled cross-season tyre model and the track-temperature correction (it is wired in but inert until weather data is ingested).

## Getting started

Run everything from the **repository root** — the backend module is `backend.api.main`, so paths only resolve from there.

**Prerequisites:** Python 3.12+ (a virtual environment or Conda environment is recommended) and Node.js `^20.19.0` or `>=22.12.0`.

**1. Backend**

```bash
pip install -e "backend/.[dev]"
```

```bash
python -m uvicorn backend.api.main:app --port 8000 --reload
```

The DuckDB schema is created automatically on startup. Interactive API docs are at <http://localhost:8000/docs>.

**2. Frontend** (in a second terminal)

```bash
cd frontend && npm install && npm run dev
```

The dashboard runs at <http://localhost:5173> and proxies `/api` to the backend on port 8000.

**3. Load some data**

The dashboard is empty until you ingest sessions. Ingestion runs in the background; `session_type` is one of `FP1`, `FP2`, `FP3`, `Q`, `SQ`, `S`, `SS`, `R`.

```bash
curl -X POST "localhost:8000/api/calendar/ingest?year=2026"
```

```bash
curl -X POST "localhost:8000/api/sessions/ingest?year=2026&round_number=4&session_type=R"
```

```bash
curl -X POST "localhost:8000/api/sessions/ingest?year=2026&event=Monaco&session_type=R"
```

```bash
curl -X POST "localhost:8000/api/sessions/sync?year=2026"
```

The last call ingests every completed Sprint and Race session for the season that is not already loaded. The sidebar in the dashboard offers the same actions.

## API

All routes are prefixed with `/api`. Session keys look like `2025_06_R` (`{year}_{round:02d}_{session_type}`). Anywhere a driver is accepted, use either the three-letter abbreviation (`VER`) or the car number (`1`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/sessions` | List ingested sessions (optional `year`) |
| `GET` | `/api/sessions/{key}` | Session metadata |
| `GET` | `/api/sessions/{key}/results` | Classified results |
| `GET` | `/api/sessions/{key}/laps` | Laps (filters: `driver`, `compound`, `exclude_pit_laps`) |
| `GET` | `/api/sessions/{key}/stints` | Stint aggregations (optional `driver`) |
| `GET` | `/api/sessions/{key}/circuit` | Circuit corner markers (fetched on demand) |
| `GET` | `/api/sessions/{key}/race-control-messages` | Flags, incidents and race control log |
| `POST` | `/api/sessions/ingest` | Ingest one session (`year` plus `round_number` or `event`) |
| `POST` | `/api/sessions/sync` | Ingest missing Sprint and Race sessions for a season |
| `GET` | `/api/calendar` | Season calendar with race and sprint winners |
| `POST` | `/api/calendar/ingest` | Fetch and store a season calendar |
| `GET` | `/api/standings/drivers` | Driver standings (`year`, optional `round_number`) |
| `GET` | `/api/standings/constructors` | Constructor standings (`year`, optional `round_number`) |
| `GET` | `/api/sessions/{key}/telemetry` | On-demand telemetry (`driver`, `lap`, `downsample`) |
| `GET` | `/api/sessions/{key}/top-speeds` | Top speeds per driver (`top_n`) |
| `GET` | `/api/sessions/{key}/radio` | Team radio messages with audio URLs |
| `GET` | `/api/sessions/{key}/tyre-degradation` | Per-stint degradation fits (`detail=summary` or `full`) |
| `GET` | `/api/championship/progression` | Points and position after every round |
| `GET` | `/api/championship/projection` | Title odds, elimination and projected trajectories |
| `POST` | `/api/championship/projection` | The same projection with what-if results pinned |
| `GET` | `/api/panels` | Panel catalogue used by the catalogue drawer |

## Configuration

Defaults come from `backend/config.py`; set any of these as environment variables to override.

| Variable | Default | Description |
|----------|---------|-------------|
| `FASTF1_CACHE_DIR` | `cache/` | FastF1 cache directory |
| `PARQUET_DATA_DIR` | `data/parquet/` | Root Parquet directory |
| `DUCKDB_PATH` | `data/pitwall.duckdb` | DuckDB file |
| `MODELS_DIR` | `data/models/` | Trained model artifacts |
| `API_HOST` | `0.0.0.0` | API bind host |
| `API_PORT` | `8000` | API bind port |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins |
| `LOG_LEVEL` | `INFO` | Logging level |
| `AUTO_INGEST_INTERVAL_HOURS` | `6` | Auto-ingestion interval |

`data/` and `cache/` are generated and git-ignored. They are expensive to rebuild, so don't delete them casually.

## Testing and linting

```bash
ruff check backend
```

```bash
python -m pytest backend/tests
```

The pytest suite covers the tyre API, the championship model, lap-time corrections, the clean-lap query and the stint models. Its `conftest.py` redirects every data path to a temporary directory, so running it never touches your real `data/` or `cache/`.

```bash
cd frontend && npm run lint && npm run build
```

`npm run build` runs `tsc -b`, which is the frontend typecheck. Two manual smoke scripts are also available: `python -m backend.test_ingest` (ingests 2024 R1 and queries it) and `python -m backend.test_fastf1` (raw FastF1 access).

## Project structure

```
backend/
├── api/          # FastAPI app and routers: sessions, standings, telemetry, panels, tyres, championship
├── db/           # DuckDB connection, schema and migrations, reusable queries
├── pipeline/     # FastF1 → Parquet → DuckDB ingestion
├── ml/           # Tyre degradation and championship projection models
├── tests/        # pytest suite
└── config.py     # Paths and settings
frontend/src/
├── panels/       # One folder per dashboard panel
├── pages/        # Full-page deep dives
├── components/   # Topbar, Sidebar, GridCanvas, PanelCard, CatalogueDrawer
├── store/        # Zustand stores: session, layout (persisted), UI
├── core/         # Panel registry
└── lib/          # Typed API client, colours, formatters, logger
```

## Adding a dashboard panel

A panel touches three places and nothing in the grid or layout system:

1.  Create `frontend/src/panels/<id>/<Name>Panel.tsx` and call `registerPanel({ id, title, category, Component })`.
2.  Add a side-effect import for it to `frontend/src/App.tsx`.
3.  Add a matching entry (same `id`, plus `title`, `category`, `description`, `defaultSize`, `minSize`) to `PANEL_CATALOGUE` in `backend/api/panels.py`.

If a feature needs more than a glanceable summary, keep the panel shallow and put the depth on a page in `frontend/src/pages/`, routed in `App.tsx`.

## Local analytics scripts

> These live in `analytics/`, `app.py`, `dashboard/` and `examples/`, which are **git-ignored** — they exist only on the author's machine and are not part of the repository.

Standalone [FastF1](https://github.com/theOehrly/Fast-F1) scripts for one-off analysis, plus a legacy Streamlit dashboard.

| Area | Scripts |
|------|---------|
| Race (`analytics/race/`) | `race_pace.py` team and driver pace, `compare_race_pace.py` two-driver pace, `lap-deltas.py` lap-by-lap delta, `long-run-pace-est.py` long-run pace from testing, `interactive_race_pace.py` Plotly box plots |
| Qualifying (`analytics/qualifying/`) | `compare_quali.py` lap telemetry comparison, `quali_h2h.py` head-to-head, `quali_years.py` year-on-year |
| Telemetry (`analytics/telemetry/`) | `compare_telemetry.py` fastest-lap comparison, `single_driver_telemetry.py`, `driving-phases.py`, `aero_setup.py` aero efficiency quadrant, `top_speed.py` |
| Tyres (`analytics/tyres/`) | `tyre-performance-modeling.py` degradation modelling, `tyre-performance.py` performance by compound, `tyre-strategy.py` race strategy |
| Calendar (`analytics/calendar/`) | `session_results.py` results with optional delta to the leader |
| Experiments (`analytics/random/`) | `fuel_analytics.py` fuel use and lift-and-coast, `overtaking_analytics.py` DRS effectiveness, `weather_crossover.py` inter/wet crossover, `predict_winner.py` |

**Running a script.** Each script has its parameters (year, event, drivers) as constants at the top. Edit them, then run from the repository root:

```bash
python analytics/telemetry/compare_telemetry.py
```

**Cache and outputs.** FastF1 refuses to start if its cache directory is missing, and the scripts are not consistent about where it is: most use either `cache/` (shared with the backend, which creates it on startup) or `analytics/cache/`. Create whichever your script points at, and the output folders under `analytics/outputs/` if a script complains:

```bash
mkdir -p cache analytics/cache analytics/outputs
```

**Streamlit dashboard.** A plugin-based dashboard (`app.py` and `dashboard/plugins/`: aero map, race pace, speed clipping, telemetry, top speed, tyre strategy):

```bash
pip install streamlit matplotlib
```

```bash
streamlit run app.py
```

## Roadmap

*   Pooled cross-season tyre degradation model, to say whether a stint was better or worse than expected.
*   Weather ingestion, which activates the track-temperature correction for degradation.
*   More predictive models for race and qualifying performance.
*   Historical season analysis beyond the current season.

## License

This project is source available under the MIT License.

## Author
Aditya Parikh - [GitHub](https://github.com/adityaparikh7)


## Acknowledgements

*   [FastF1](https://github.com/theOehrly/Fast-F1) for the incredible API providing F1 timing and telemetry data.
*   The F1 community for inspiring data analysis and visualization projects.
