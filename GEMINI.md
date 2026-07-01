# GEMINI.md — F1 Pitwall Project Context

## Project Overview
**F1 Pitwall** is a comprehensive Formula 1 analytics platform and dashboard. It combines a high-performance data pipeline with a modern web interface to provide insights into race telemetry, strategy, and performance.

### Architecture
- **Frontend**: React (TypeScript) SPA built with Vite. It features a customisable grid-based dashboard with 14 analytics panels, a panel catalogue drawer, client-side routing, and persistent layout management via localStorage.
- **Backend**: FastAPI (Python) serving as the orchestration layer and API provider. Includes GZip middleware, CORS, and lifespan-managed DuckDB connections.
- **Data Pipeline**: ETL system that fetches data from [FastF1](https://github.com/theOehrly/Fast-F1), normalises it into Parquet files, and loads it into a DuckDB feature store. Supports per-session ingestion, calendar ingestion, and automated season sync for missing sessions.
- **Storage**: DuckDB for structured queryable data; Parquet for persistent file-based storage (laps, results, standings); FastF1 cache for raw telemetry.
- **Legacy Dashboard**: A Streamlit-based dashboard (`app.py`) using a plugin-based visualisation registry in `dashboard/`. This is separate from the main React frontend.
- **Analytics**: Standalone Python scripts in `analytics/` and `examples/` for deep-dive telemetry and performance modelling (e.g. corner annotation, speed traces, tyre strategy, winner prediction).

---

## Technical Stack
- **Frontend**: React 19, TypeScript 6, Vite 8, Zustand 5 (state), React Grid Layout 2.x, React Router DOM 7, Plotly.js 3.x / react-plotly.js 2.x, Recharts 3.x (declared but unused), Lucide React (icons).
- **Backend**: Python 3.12+, FastAPI ≥0.115, DuckDB ≥1.0, Pandas ≥2.0, PyArrow ≥16.0, FastF1 ≥3.0, Uvicorn, Pydantic ≥2.0, APScheduler ≥3.10, httpx ≥0.27, websockets ≥12.0.
- **Database**: DuckDB (local file: `data/pitwall.duckdb`).
- **Legacy**: Streamlit, Matplotlib, FastF1 (for `app.py` dashboard).

---

## Getting Started

### Backend Setup
1. Navigate to the `backend/` directory.
2. Install dependencies:
   ```bash
   pip install -e .
   # or for development (includes ruff, pytest):
   pip install -e ".[dev]"
   ```
3. Run the API server:
   ```bash
   python -m uvicorn backend.api.main:app --reload
   ```
   *Note: The server will automatically initialise the DuckDB schema on startup via lifespan events.*

### Frontend Setup
1. Navigate to the `frontend/` directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
   The frontend dev server proxies `/api` requests to `http://localhost:8000` (configured in Vite).

### Legacy Streamlit Dashboard
```bash
pip install streamlit matplotlib fastf1
streamlit run app.py
```

### Data Ingestion
Data is ingested via API endpoints or internal pipeline calls.
- **Calendar Ingestion**: `POST /api/calendar/ingest?year=2026`
- **Session Ingestion**: `POST /api/sessions/ingest?year=2026&round_number=4&session_type=R`
- **Session Ingestion by Event Name**: `POST /api/sessions/ingest?year=2026&event=Monaco&session_type=R`
- **Season Sync** (auto-ingest missing Sprint + Race sessions): `POST /api/sessions/sync?year=2026`

---

## API Reference

All routes are prefixed with `/api`. The backend exposes four routers:

### Health
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check. Returns `{"status": "ok", "service": "f1-pitwall"}` |

### Sessions Router (`sessions.py`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List sessions (optional `?year=`) |
| `GET` | `/api/sessions/{session_key}` | Get session metadata |
| `GET` | `/api/sessions/{session_key}/results` | Get classified results |
| `GET` | `/api/sessions/{session_key}/laps` | Get laps (filters: `driver`, `compound`, `exclude_pit_laps`). Driver can be abbreviation (e.g. `VER`) or number (e.g. `1`). |
| `GET` | `/api/sessions/{session_key}/stints` | Get stint aggregations (optional `?driver=`). Driver can be abbreviation or number. |
| `GET` | `/api/sessions/{session_key}/circuit` | Get circuit corner markers (on-demand from FastF1) |
| `POST` | `/api/sessions/ingest` | Trigger ETL for a session (background). Requires `year` (≥2018) + either `round_number` or `event`. Optional `session_type` (default: `R`). Validates session existence before queueing. |
| `POST` | `/api/sessions/sync` | Background sync missing sessions for a season. Required `year` (≥2018). |
| `GET` | `/api/calendar` | Get season calendar with race/sprint winners. Required `year` (≥2018). |
| `POST` | `/api/calendar/ingest` | Fetch and store season calendar. Required `year` (≥2018). |

### Standings Router (`standings.py`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/standings/drivers` | Driver championship standings (computed from results). Required `year` (≥2018), optional `round_number`. |
| `GET` | `/api/standings/constructors` | Constructor championship standings. Required `year` (≥2018), optional `round_number`. |

### Telemetry Router (`telemetry.py`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/{session_key}/telemetry` | On-demand telemetry fetch. Params: `driver` (1-3 chars), `lap` (`fastest`/`personal_best`/number), `downsample` (1-100). |
| `GET` | `/api/sessions/{session_key}/top-speeds` | Get top speeds per driver. Auto-detects source (speed trap data vs telemetry car data). Param: `top_n` (1-50, default 15). Returns `{ source, data: [{ driver, top_speeds, average, best }] }`. |

### Panels Router (`panels.py`)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/panels` | Return the panel catalogue (static registry) |

### Session Key Format
Session keys follow the pattern `{year}_{round:02d}_{session_type}`, e.g. `2025_06_R`, `2025_03_Q`.

---

## Database Schema

Six DuckDB tables in `backend/db/schema.py`:

### `sessions`
| Column | Type | Notes |
|--------|------|-------|
| `session_key` | `VARCHAR` (PK) | e.g. `2025_06_R` |
| `year` | `INTEGER` | NOT NULL |
| `round_number` | `INTEGER` | |
| `event_name` | `VARCHAR` | NOT NULL |
| `country` | `VARCHAR` | |
| `circuit_name` | `VARCHAR` | |
| `session_type` | `VARCHAR` | NOT NULL. FP1, FP2, FP3, Q, SQ, S, SS, R |
| `date` | `DATE` | |
| `total_laps` | `INTEGER` | |
| `data_quality` | `VARCHAR` | DEFAULT 'full'. full / partial / minimal |

### `laps`
PK: `(session_key, driver, lap_number)`. Columns: driver, driver_number, team, lap_time (seconds), sector1/2/3_time, compound, tyre_life, stint, is_personal_best, is_pit_out_lap, is_pit_in_lap, track_status, position.

### `results`
PK: `(session_key, driver)`. Columns: driver_number, team, position, grid_position, status, points, time (seconds), gap_to_leader, fastest_lap, fastest_lap_number, pit_stops, q1_time, q2_time, q3_time, best_lap_time. Qualifying times and practice best laps are populated per session type.

### `driver_standings`
PK: `(year, round_number, driver)`. Columns: position, driver_number, team, points, wins. *Note: Currently computed live from `results` table via SQL CTEs in `queries.py` rather than stored directly.*

### `constructor_standings`
PK: `(year, round_number, constructor)`. Columns: position, points, wins. *Same note as driver_standings.*

### `calendar`
PK: `(year, round_number)`. Columns: event_name, country, circuit_name, event_date, event_format (conventional, sprint_shootout, sprint_qualifying, testing).

### Schema Migrations
The `initialise_schema()` function runs on startup and includes a migration step (`_migrate_results_table`) to add `q1_time`, `q2_time`, `q3_time`, and `best_lap_time` columns to existing `results` tables.

### Parquet Views
`refresh_parquet_views()` creates optional views (`v_laps`, `v_results`, `v_standings`) that read directly from Parquet file directories for ad-hoc queries.

---

## Frontend Architecture

### Routing
- `/` — Main grid dashboard
- `/race-pace` — Dedicated Race Pace Analysis page
- `/telemetry` — Dedicated Telemetry Comparison page

Uses `react-router-dom` v7 with `BrowserRouter`.

### Panel System
The dashboard uses a panel-based architecture:

1. **Registry** (`frontend/src/core/panelRegistry.ts`): Central `Map<string, PanelDefinition>` with `registerPanel()`, `getPanel()`, `getAllPanels()`.
2. **PanelProps interface**: Every panel receives `{ sessionKey, config, width, height }`.
3. **Auto-registration**: Each panel file calls `registerPanel()` on import; `App.tsx` imports all panels.

### Registered Panels (14 active)

| ID | Title | Category | Description |
|----|-------|----------|-------------|
| `session-results` | Session Results | session | Classified finishing order with gap, fastest lap, pit stops. Supports race, qualifying (Q1/Q2/Q3), sprint qualifying, and practice sessions with session-type-specific column layouts. |
| `season-calendar` | Season Calendar | session | Full season schedule with round numbers, session types, race/sprint winners. Highlights next upcoming event with animated glow. |
| `driver-standings` | Driver Standings | session | Driver championship standings with points (computed live from results). |
| `constructor-standings` | Constructor Standings | session | Constructor championship standings with team colour blocks. |
| `telemetry-explorer` | Telemetry Explorer | telemetry | Compare driver telemetry traces — speed, throttle, brake, gear, RPM, DRS. Supports 2 drivers side-by-side with interactive crosshair hover tooltip. Corner markers overlay. |
| `track-map` | Track Map | session | Circuit map with mini-sector speed colouring and corner annotations. Auto-loads fastest lap on session change. |
| `qualifying-comparison` | Qualifying Comparison | telemetry | Head-to-head qualifying lap comparison with sector breakdown and colour-coded deltas. |
| `aero-map` | Aero Map | telemetry | Two view modes: Circuit Map (aero metrics on track layout) and Efficiency Quadrant (mean speed vs top speed scatter per team). |
| `lap-distribution` | Lap Time Distribution | performance | Box plots per driver using Plotly.js. Scatter points coloured by tyre compound. "Proper Laptimes" and "Only Finishers" filters. "⤢ Expand" button navigates to `/race-pace`. |
| `lap-progression` | Lap Time Progression | performance | SVG line chart of lap times vs lap number for all drivers. Hover to highlight. 5th–95th percentile Y-axis clipping. |
| `position-changes` | Position Changes | performance | SVG chart plotting position (Y, inverted) vs lap (X) for all drivers. Hover highlights. |
| `top-speed-plot` | Top Speed Plot | performance | Heatmap table of top speeds reached for N laps by drivers. Uses `GET /api/sessions/{key}/top-speeds` endpoint. Configurable top-N slider. |
| `driving-phases-plot` | Driving Phases Plot | telemetry | Scatter-plot of every telemetry sample on the circuit map, coloured by speed/throttle/brake channel. Shows braking zones, acceleration zones, and top-speed traps. Supports multiple drivers simultaneously. |
| `strategy-board` | Strategy Board | strategy | Horizontal Gantt chart of tyre stint timelines per driver with compound colours and lap counts. Sorted by finishing position. SVG-based. |

*Note: `speed-trace` panel exists in source (`frontend/src/panels/speed-trace/`) but is currently **disabled** — its import is commented out in `App.tsx` and it is removed from the panel catalogue in `panels.py`.*

### State Management (Zustand Stores)

| Store | File | Purpose |
|-------|------|---------|
| `useSessionStore` | `frontend/src/store/sessionStore.ts` | Active session context (key + metadata), session list, year selection, synced years set, auto-sync of missing sessions on year change. Persists active session key to `localStorage` separately. |
| `useLayoutStore` | `frontend/src/store/layoutStore.ts` | Grid layout positions, active panel instances (7 default panels), current layout name, saved named layouts. Persisted via `zustand/persist` to localStorage under key `pitwall_layout`. Actions: `setLayout`, `addPanel`, `removePanel`, `updatePanelConfig`, `saveLayout`, `loadLayout`, `deleteLayout`. |
| `useUIStore` | `frontend/src/store/uiStore.ts` | Transient UI: sidebar collapsed state, catalogue drawer open/close |

### Shared Components

| Component | File | Purpose |
|-----------|------|---------|
| `Topbar` | `Topbar.tsx` | App header: logo (links to `/`), year selector (2018–2026), session breadcrumb, layout management (save/load), "+ Panel" button. Uses Lucide icons (`Menu`, `Save`, `Plus`). |
| `Sidebar` | `Sidebar.tsx` | Session ingestion form (event name input, session type dropdown, Ingest/Calendar/Sync buttons), scrollable session list with re-ingest button per session. Uses Lucide icons (`CalendarSync`, `RefreshCw`, `RotateCcw`). Collapsible. |
| `GridCanvas` | `GridCanvas.tsx` | React Grid Layout canvas that renders active `PanelCard`s. `ResizeObserver` for responsive width. 12-col grid, 60px row height, vertical compaction. |
| `PanelCard` | `PanelCard.tsx` | Card wrapper: draggable header with title + close button (Lucide `X`). `ResizeObserver` for content dimensions (debounced 150ms). |
| `CatalogueDrawer` | `CatalogueDrawer.tsx` | Slide-out drawer (right side) for adding panels. Search input, grouped by category. Loads catalogue from backend API. Keyboard shortcuts: `⌘K` to toggle, `Escape` to close. |

### Utility Libraries

| Module | File | Purpose |
|--------|------|---------|
| `api.ts` | `frontend/src/lib/api.ts` | Typed API client — all backend calls go through this. Exports 12 typed interfaces (`SessionMeta`, `LapData`, `StintData`, `ResultData`, `TelemetryPoint`, `TelemetryResponse`, `TopSpeedData`, `TopSpeedsResponse`, `CornerData`, `DriverStanding`, `ConstructorStanding`, `CalendarEvent`, `PanelCatalogueItem`) and `api` object with 16 functions. Uses `logger` for debug/error logging. |
| `colours.ts` | `frontend/src/lib/colours.ts` | `TEAM_COLOURS` (21 teams incl. historical), `DRIVER_TEAMS` (20 drivers, 2025 season), `getTeamColour()`, `getDriverColour()`, `adjustColorLightness()` (HSL-based smart lightness adjuster), `COMPOUND_COLOURS` (5 + UNKNOWN), `getCompoundColour()`. Central source — never hardcode colours in panels. |
| `format.ts` | `frontend/src/lib/format.ts` | Formatting: `formatLapTime`, `formatGap`, `formatRaceTime` (hrs:min:sec.ms for winner total time), `formatPosition`, `formatSectorTime`, `formatPoints`, `formatDate`, `formatCompound`, `formatSessionType`, `getPaceRating`, `getProperLapThreshold`. |
| `logger.ts` | `frontend/src/lib/logger.ts` | Structured frontend logging with colour-coded console output. Suppresses DEBUG in production. Levels: `debug`, `info`, `warn`, `error`. Used by `api.ts` and `main.tsx`. |

### Dedicated Pages

| Page | Route | File | Description |
|------|-------|------|-------------|
| Race Pace Analysis | `/race-pace` | `frontend/src/pages/RacePacePage.tsx` (19.7KB) | Full-page race pace analysis with driver + team box plots (Plotly), pace ranking tables, compound-coloured scatter points, 107% filter, finisher-only filter. |
| Telemetry Comparison | `/telemetry` | `frontend/src/pages/TelemetryPage.tsx` (38.5KB) | Full-page telemetry comparison: two-driver head-to-head with per-lap selection. Channels: track map (with track dominance colouring), time delta, speed, throttle, brake, gear — all toggleable. Features interactive crosshair hover, corner annotations, lap info cards (sector times, compound, tyre life), animated lap playback with speed control. SVG-based. |

---

## Pipeline Architecture

### ETL Flow
`FastF1` → `Pandas` → `Parquet` → `DuckDB`

### Ingestion Pipeline (`backend/pipeline/ingest.py`)

| Function | Purpose |
|----------|---------|
| `ingest_session(year, round_number, event, session_type, on_progress)` | Full session ingestion: metadata, laps, results. Handles race, qualifying, sprint, and practice sessions with session-type-specific logic. Optional `on_progress` callback for progress reporting. Accepts either `round_number` or `event` name as identifier. |
| `ingest_calendar(year)` | Fetches season schedule from FastF1 and stores in `calendar` table. |
| `fetch_telemetry(year, round_number, event, session_type, driver, lap)` | On-demand telemetry fetch (not batch stored). Returns `(real_driver, data)` tuple with distance, time, speed, throttle, brake, gear, RPM, DRS, X/Y coordinates. Falls back to `get_car_data().add_distance()` if `get_telemetry()` fails. |
| `fetch_circuit_info(year, round_number, event, session_type)` | Fetches circuit corner markers (number, letter, angle, distance, x, y). |
| `sync_season_sessions(year)` | Auto-ingests missing Sprint + Race sessions for a given year. Checks completed sessions > 3 hours old. Rate-limit-aware (skips practice/qualifying). |

### Session-Type Handling in Results
- **Race/Sprint**: Gap computed from cumulative time column.
- **Qualifying (Q/SQ/SS)**: Q1/Q2/Q3 times extracted and stored; position derived from best qualifying lap.
- **Practice (FP1/FP2/FP3)**: Best lap per driver computed from lap data; position and gap derived from best lap time.

---

## Logging

### Backend (`backend/logger.py`)
Custom ANSI colour-coded `ColoredFormatter` for terminal output. Format: `HH:MM:SS | LEVEL (coloured) | logger_name | message`. Called via `setup_logging(LOG_LEVEL)` in `main.py` on startup. Silences noisy `uvicorn.access` logger.

### Frontend (`frontend/src/lib/logger.ts`)
Structured `Logger` class with CSS-styled console output. Levels: DEBUG (grey, suppressed in production), INFO (blue), WARN (yellow), ERROR (red). Singleton `logger` exported and used by `api.ts` and `main.tsx`.

---

## Configuration (`backend/config.py`)

All paths relative to project root. Overridable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FASTF1_CACHE_DIR` | `cache/` | FastF1 cache directory |
| `PARQUET_DATA_DIR` | `data/parquet/` | Root parquet directory |
| `DUCKDB_PATH` | `data/pitwall.duckdb` | DuckDB file path |
| `API_HOST` | `0.0.0.0` | API bind host |
| `API_PORT` | `8000` | API bind port |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated CORS origins |
| `LOG_LEVEL` | `INFO` | Logging level |
| `AUTO_INGEST_INTERVAL_HOURS` | `6` | Auto-ingestion interval |

Constants: `MIN_SEASON = 2018` (earliest season with reliable FastF1 data).

Parquet subdirectories: `sessions/`, `laps/`, `telemetry/`, `results/`, `standings/`. Auto-created on import.

---

## Legacy Dashboard (`dashboard/` + `app.py`)

A Streamlit-based modular dashboard system separate from the React frontend.

### Plugin System
- **`dashboard/core.py`**: FastF1 session loading, event/driver/team option helpers. Uses `SessionQuery` dataclass for race/testing sessions.
- **`dashboard/registry.py`**: `VisualizationSpec` dataclass with `key`, `title`, `category`, `description`, `render()` callable, `parameters`, and `supports_testing` flag. Central `_REGISTRY` dict.
- **`dashboard/discovery.py`**: `autodiscover_plugins()` — auto-imports all modules under `dashboard/plugins/`.
- **`dashboard/helpers.py`**: Fallback team colours, `format_lap_time()`, `get_team_color_safe()`, `adjust_color_lightness()`.

### Dashboard Plugins (`dashboard/plugins/`)
| Plugin | Description |
|--------|-------------|
| `aero_map.py` | Aero map visualisation |
| `race_pace.py` | Race pace analysis |
| `speed_clipping.py` | Speed clipping detection |
| `telemetry.py` | Multi-view telemetry (speed, throttle, brake, gear, RPM, DRS) |
| `top_speed.py` | Top speed analysis |
| `tyre_strategy.py` | Tyre strategy visualisation |

### Running
```bash
streamlit run app.py
```

---

## Development Conventions

### Backend
- **Code Style**: PEP 8 via `ruff`. Line length: 120. Target: Python 3.12.
- **Lint rules**: `E`, `F`, `I`, `UP` (pyflakes, isort, pyupgrade).
- **Data Flow**: `FastF1` → `Pandas` → `Parquet` → `DuckDB`.
- **API**: All routes prefixed with `/api`. Four routers: `sessions`, `standings`, `telemetry`, `panels`.
- **Database**: Use `backend.db.connection.get_connection()` for the singleton DuckDB connection.
- **Logging**: Use `backend.logger.setup_logging()` (called once on startup). All modules use `logging.getLogger(__name__)`.
- **Middleware**: GZip (1000 byte minimum), CORS.
- **Background Tasks**: FastAPI `BackgroundTasks` for ingestion (non-blocking).
- **Queries**: Reusable query functions in `backend/db/queries.py` return `list[dict]` (JSON-ready). Uses `fetchdf()` for pandas-based serialisation. Driver filter queries support both abbreviation and driver number.

### Frontend
- **State Management**: Zustand stores in `frontend/src/store/`. Three stores: `sessionStore`, `layoutStore` (persisted), `uiStore`.
- **API Interaction**: All backend calls go through the typed client in `frontend/src/lib/api.ts`. The frontend never reads Parquet or DuckDB directly.
- **Colours**: Central colour config in `frontend/src/lib/colours.ts`. Never hardcode driver/team colours in components.
- **Formatting**: All display values use formatters from `frontend/src/lib/format.ts`.
- **Logging**: Use `frontend/src/lib/logger.ts` instead of raw `console.log`.
- **Icons**: Use `lucide-react` for all icons (Menu, Save, Plus, X, CalendarSync, RefreshCw, RotateCcw, etc.).
- **Components**: Functional components with hooks. Styling via `index.css` (global) with CSS custom properties (design tokens).
- **Panels**: New dashboard panels must:
  1. Create a directory under `frontend/src/panels/{panel-id}/`.
  2. Call `registerPanel()` in the component file.
  3. Import the panel file in `App.tsx`.
  4. Add a catalogue entry to `PANEL_CATALOGUE` in `backend/api/panels.py`.
- **Pages**: Dedicated full-page views go in `frontend/src/pages/` and are routed in `App.tsx`.

### Testing
- **Backend**: `pytest` with `pytest-asyncio`. Config in `pyproject.toml` (`testpaths = ["tests"]`).
- **Linting**: `ruff check .` (backend), `npm run lint` (frontend).
- **Build check**: `npm run build` (frontend — `tsc -b && vite build`).

---

## Directory Map

```
.
├── GEMINI.md              # AI agent project context (this file)
├── readme.md              # Project README
├── app.py                 # Legacy Streamlit dashboard entry point
├── run.sh                 # Startup script — runs both backend + frontend
├── .gitignore
│
├── backend/               # FastAPI application and data pipeline
│   ├── __init__.py
│   ├── config.py          # All config: paths, env vars, constants
│   ├── logger.py          # ANSI-coloured logging formatter and setup
│   ├── pyproject.toml     # Python package definition and dependencies
│   ├── test_ingest.py     # Quick ingestion test script
│   ├── test_fastf1.py     # FastF1 telemetry column test script
│   ├── api/               # REST API routers
│   │   ├── main.py        # FastAPI app, middleware, lifespan, router mounts
│   │   ├── sessions.py    # Sessions, laps, results, stints, calendar, ingestion
│   │   ├── standings.py   # Driver & constructor championship standings
│   │   ├── telemetry.py   # On-demand telemetry fetching + top speeds
│   │   └── panels.py      # Panel catalogue (static registry)
│   ├── db/                # DuckDB schema and connection
│   │   ├── connection.py  # Singleton connection manager
│   │   ├── schema.py      # Table DDL, migrations, Parquet views
│   │   └── queries.py     # Reusable query functions (JSON-ready output)
│   └── pipeline/          # ETL logic
│       └── ingest.py      # Session, calendar, telemetry ingestion + season sync
│
├── frontend/              # React dashboard application
│   ├── package.json
│   └── src/
│       ├── main.tsx       # Entry point (BrowserRouter + StrictMode + logger init)
│       ├── App.tsx         # Shell: Topbar, Sidebar, GridCanvas, CatalogueDrawer, Routes
│       ├── index.css       # Global styles with CSS custom properties (design tokens)
│       ├── core/
│       │   └── panelRegistry.ts  # Panel type registry (Map-based)
│       ├── components/    # Shared UI components
│       │   ├── Topbar.tsx
│       │   ├── Sidebar.tsx
│       │   ├── GridCanvas.tsx
│       │   ├── PanelCard.tsx
│       │   └── CatalogueDrawer.tsx
│       ├── panels/        # Dashboard visualisation panels (14 active + 1 disabled)
│       │   ├── aero-map/
│       │   ├── constructor-standings/
│       │   ├── driver-standings/
│       │   ├── driving-phases-plot/      # NEW — telemetry heatmap on circuit
│       │   ├── lap-distribution/
│       │   ├── lap-progression/
│       │   ├── position-changes/
│       │   ├── qualifying-comparison/
│       │   ├── season-calendar/
│       │   ├── session-results/
│       │   ├── speed-trace/              # DISABLED — commented out in App.tsx
│       │   ├── strategy-board/
│       │   ├── telemetry-explorer/
│       │   ├── top-speed-plot/
│       │   └── track-map/
│       ├── pages/         # Dedicated full-page views
│       │   ├── RacePacePage.tsx
│       │   └── TelemetryPage.tsx         # NEW — full telemetry comparison
│       ├── store/         # Zustand state stores
│       │   ├── sessionStore.ts
│       │   ├── layoutStore.ts
│       │   └── uiStore.ts
│       └── lib/           # Utilities
│           ├── api.ts     # Typed API client (all backend calls)
│           ├── colours.ts # Team/driver/compound colour maps
│           ├── format.ts  # Display formatters
│           └── logger.ts  # Structured frontend logging
│
├── dashboard/             # Legacy Streamlit plugin-based dashboard
│   ├── __init__.py
│   ├── core.py            # FastF1 session loader, event/driver helpers
│   ├── registry.py        # VisualizationSpec registry
│   ├── discovery.py       # Auto-discovery of plugins
│   ├── helpers.py         # Colour helpers, lap time formatting
│   └── plugins/           # Registered visualisation plugins
│       ├── aero_map.py
│       ├── race_pace.py
│       ├── speed_clipping.py
│       ├── telemetry.py
│       ├── top_speed.py
│       └── tyre_strategy.py
│
├── analytics/             # Standalone Python scripts for analysis
│   ├── calendar/          # Season schedule, session results, standings
│   ├── qualifying/        # Qualifying comparison, head-to-head, cross-year
│   ├── race/              # Race pace, lap deltas, long-run estimation
│   ├── random/            # Experimental: fuel, overtaking, pitstop sim, prediction
│   ├── telemetry/         # Aero setup, telemetry comparison, driving phases, top speed
│   └── tyres/             # Tyre performance modelling, strategy
│
├── examples/              # Example scripts (FastF1 usage, plotting)
│   ├── plot_annotate_corners.py
│   ├── plot_driver_laptimes.py
│   ├── plot_gear_shifts_on_track.py
│   ├── plot_laptimes_distribution.py
│   ├── plot_position_changes.py
│   ├── plot_qualifying_results.py
│   ├── plot_results_tracker.py
│   ├── plot_speed_on_track.py
│   ├── plot_speed_traces.py
│   ├── plot_strategy.py
│   ├── plot_team_pace_ranking.py
│   ├── plot_who_can_still_win_wdc.py
│   ├── predict_winner.py
│   └── ...
│
├── data/                  # Local database and Parquet storage
│   ├── pitwall.duckdb
│   └── parquet/
│       ├── sessions/
│       ├── laps/
│       ├── telemetry/
│       ├── results/
│       └── standings/
│
├── cache/                 # FastF1 data cache (git-ignored)
├── docs/                  # Project documentation
│   ├── DESIGN.md
│   ├── FUTURE_WORK.md
│   ├── PRD.md
│   ├── TECH_STACK.md
│   ├── TODO.md
│   ├── CLAUDE.md          # Claude AI agent context
│   └── plans/
│
└── skills/                # AI agent skill definitions
    ├── dataviz/
    └── fastf1/
        └── SKILL.md
```

### Git Tracking
Only `backend/`, `frontend/`, `GEMINI.md`, `readme.md`, and `.gitignore` are tracked in git. Directories `analytics/`, `data/`, `dashboard/`, `docs/`, `examples/`, `skills/`, `cache/`, and `app.py` are git-ignored (local development only).

---

## Key Design Decisions

1. **Telemetry is on-demand, not batch-ingested.** Telemetry data is fetched directly from FastF1 when requested via the API, then cached by FastF1 locally. This avoids massive storage requirements.
2. **Top speeds use intelligent source detection.** The `/top-speeds` endpoint checks for speed trap data (`SpeedST` column) first and falls back to computing max speed from telemetry car data if unavailable.
3. **Standings are computed, not stored.** Driver and constructor standings are computed via SQL CTE aggregation over the `results` table rather than being stored in their own tables. The `driver_standings` and `constructor_standings` tables exist in the schema but aren't populated by the pipeline.
4. **Session sync is rate-limit aware.** `sync_season_sessions()` only auto-ingests Sprint and Race sessions (not practice/qualifying) to stay within FastF1's 500 requests/hour limit.
5. **Layout persistence.** Dashboard layouts are saved to localStorage via Zustand's `persist` middleware under the key `pitwall_layout`.
6. **Panel catalogue is dual-registered.** Panels are registered both server-side (in `backend/api/panels.py` for the catalogue drawer) and client-side (via `registerPanel()` for rendering).
7. **CSS custom properties (design tokens).** The frontend uses CSS variables for theming — `--surface-primary`, `--text-primary`, `--border-subtle`, `--space-*`, `--fs-*`, `--radius-*`, etc. defined in `index.css`.
8. **Session ingestion validates before queueing.** The `POST /sessions/ingest` endpoint validates that the session exists in FastF1 before adding the background task, providing immediate error feedback for non-existent sessions.
9. **Telemetry page supports animated playback.** The dedicated Telemetry page includes a playback system with variable speed control, animating car position markers along the circuit path.
