/**
 * F1 Pitwall — Typed API Client
 *
 * All backend communication goes through this module.
 * The frontend never reads Parquet or DuckDB directly.
 */

import { logger } from './logger';

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const method = options?.method || 'GET';

  logger.debug(`API Request: ${method} ${path}`);

  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`API Error ${response.status} (${method} ${path}): ${errorText}`);
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    return response.json();
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith('API Error')) {
      logger.error(`Network Error (${method} ${path}): ${err.message}`);
    }
    throw err;
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface SessionMeta {
  session_key: string;
  year: number;
  round_number: number;
  event_name: string;
  country: string;
  circuit_name: string;
  session_type: string;
  date: string | null;
  total_laps: number | null;
  data_quality: string;
}

export interface LapData {
  session_key: string;
  driver: string;
  driver_number: number | null;
  team: string | null;
  lap_number: number;
  lap_time: number | null;
  sector1_time: number | null;
  sector2_time: number | null;
  sector3_time: number | null;
  compound: string | null;
  tyre_life: number | null;
  stint: number | null;
  is_personal_best: boolean | null;
  is_pit_out_lap: boolean | null;
  is_pit_in_lap: boolean | null;
  track_status: string | null;
  position: number | null;
}

export interface StintData {
  session_key: string;
  driver: string;
  team: string | null;
  stint: number;
  compound: string | null;
  start_lap: number;
  end_lap: number;
  lap_count: number;
  avg_lap_time: number | null;
  best_lap_time: number | null;
}

// ── Tyre degradation ────────────────────────────────────────────────

/**
 * Degradation rate for one stint.
 *
 * `s_per_lap` is a model-agnostic finite difference of the fitted curve across
 * [`window_lo`, `window_hi`], never a raw model coefficient — a coefficient means something
 * different in each model family and is not comparable across them.
 *
 * Two flags gate how this may be displayed, and both matter:
 *
 * - `window_source` is `'nominal'` when the stint spanned tyre life 5–15, `'observed'` when
 *   it was measured over the stint's own shorter range (most soft stints). Never compare a
 *   nominal figure with an observed one.
 * - `significant` is false when the rate is within two standard errors of zero, i.e. the
 *   stint shows no degradation distinguishable from a flat line. Do not rank or headline
 *   these: a noisy fit yields an extreme slope, so unfiltered they sort to the top.
 */
export interface TyreDegradation {
  s_per_lap: number | null;
  se_s_per_lap: number | null;
  significant: boolean;
  window_lo: number;
  window_hi: number;
  window_source: 'nominal' | 'observed';
  comparable: boolean;
  s_per_lap_full_range: number | null;
  full_range_lo: number;
  full_range_hi: number;
}

export interface TyreDegradationLap {
  lap_number: number;
  tyre_life: number;
  lap_time: number | null;
  lap_time_corrected: number | null;
  /** Dropped by the outlier filter before fitting; shown de-emphasised, not hidden. */
  is_outlier: boolean;
}

export interface TyreDegradationCurvePoint {
  tyre_life: number;
  fit: number | null;
  /** Null when the bootstrap was disabled or could not converge. */
  lo: number | null;
  hi: number | null;
}

export interface TyreDegradationStint {
  driver: string;
  driver_number: number | null;
  team: string | null;
  stint: number;
  compound: string | null;
  start_lap: number;
  end_lap: number;
  tyre_life_start: number;
  tyre_life_end: number;
  n_laps_total: number;
  n_laps_clean: number;
  n_laps_dropped_outlier: number;
  model: string;
  converged: boolean;
  params: (number | null)[];
  param_names: string[];
  fit: { rss: number | null; rmse: number | null; r2: number | null; aicc: number | null };
  model_comparison: {
    model: string;
    k: number;
    aicc: number | null;
    rmse: number | null;
    selected: boolean;
  }[];
  degradation: TyreDegradation;
  cliff_tyre_life: number | null;
  anomaly: {
    z_score: number | null;
    is_anomalous: boolean;
    /** e.g. "HARD:nominal" — encodes that peers share compound AND window source. */
    peer_group: string;
    peer_count: number;
  } | null;
  /** Present only when detail=full. */
  laps?: TyreDegradationLap[];
  /** Present only when detail=full. */
  curve?: TyreDegradationCurvePoint[];
}

export interface TyreDegradationResponse {
  session_key: string | null;
  event_name?: string | null;
  circuit_name?: string | null;
  session_type?: string | null;
  year?: number | null;
  session_median_lap_time?: number | null;
  config: {
    min_laps: number;
    models: string[];
    detail: string;
    corrections_applied: { name: string; [key: string]: unknown }[];
    corrections_skipped: { name: string; reason: string }[];
    nominal_window: number[];
    bootstrap: boolean;
    bootstrap_iterations: number;
    n_clean_laps: number;
    /**
     * Field pace trend in s/lap: the sum of fuel burn-off, track evolution and the field's
     * own average degradation. Near -0.055 on a typical race. A large divergence means
     * absolute degradation for this session is biased, and `warnings` will say so.
     */
    field_trend_s_per_lap: number | null;
  };
  stints: TyreDegradationStint[];
  compound_summary: {
    compound: string;
    n_stints: number;
    n_stints_comparable: number;
    window_sources: string[];
    median_deg_s_per_lap: number | null;
    p25_deg_s_per_lap: number | null;
    p75_deg_s_per_lap: number | null;
  }[];
  warnings: string[];
}

export interface ResultData {
  session_key: string;
  driver: string;
  driver_number: number | null;
  team: string | null;
  position: number | null;
  grid_position: number | null;
  status: string | null;
  points: number | null;
  time: number | null;
  gap_to_leader: string | null;
  fastest_lap: number | null;
  fastest_lap_number: number | null;
  pit_stops: number | null;
  q1_time: number | null;
  q2_time: number | null;
  q3_time: number | null;
  best_lap_time: number | null;
}

export interface TelemetryPoint {
  distance: number | null;
  time: number | null;
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  gear: number | null;
  rpm: number | null;
  drs: number | null;
  x: number | null;
  y: number | null;
}

export interface TelemetryResponse {
  session_key: string;
  driver: string;
  lap: string;
  sample_count: number;
  data: TelemetryPoint[];
}

export interface TopSpeedData {
  driver: string;
  top_speeds: (number | null)[];
  average: number | null;
  best: number | null;
}

export interface TopSpeedsResponse {
  source: string;
  data: TopSpeedData[];
}

export interface CornerData {
  number: number;
  letter: string | null;
  angle: number | null;
  distance: number | null;
  x: number | null;
  y: number | null;
}

export interface RaceControlMessage {
  Time: string | null;
  Category: string | null;
  Message: string | null;
  Status: string | null;
  Flag: string | null;
  Scope: string | null;
  Sector: number | null;
  RacingNumber: string | null;
  Lap: number | null;
}

export interface DriverStanding {
  year: number;
  round_number: number;
  position: number;
  driver: string;
  driver_number: number | null;
  team: string | null;
  points: number;
  wins: number;
}

export interface ConstructorStanding {
  year: number;
  round_number: number;
  position: number;
  constructor: string;
  points: number;
  wins: number;
}

export interface CalendarEvent {
  year: number;
  round_number: number;
  event_name: string;
  country: string;
  circuit_name: string;
  event_date: string | null;
  event_format: string;
  winner: string | null;
  winner_team: string | null;
  sprint_winner: string | null;
  sprint_winner_team: string | null;
}

export interface RadioMessage {
  utc: string;
  driver: string;
  driver_number: string;
  team_color: string;
  audio_url: string;
}

export interface PanelCatalogueItem {
  id: string;
  title: string;
  category: string;
  description: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
}

// ── API Functions ───────────────────────────────────────────────────

export const api = {
  // Health
  health: () => request<{ status: string }>('/health'),

  // Sessions
  listSessions: (year?: number) =>
    request<SessionMeta[]>(year ? `/sessions?year=${year}` : '/sessions'),

  getSession: (key: string) =>
    request<SessionMeta>(`/sessions/${key}`),

  getResults: (key: string) =>
    request<ResultData[]>(`/sessions/${key}/results`),

  getLaps: (key: string, params?: { driver?: string; compound?: string; exclude_pit_laps?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.driver) searchParams.set('driver', params.driver);
    if (params?.compound) searchParams.set('compound', params.compound);
    if (params?.exclude_pit_laps) searchParams.set('exclude_pit_laps', 'true');
    const qs = searchParams.toString();
    return request<LapData[]>(`/sessions/${key}/laps${qs ? `?${qs}` : ''}`);
  },

  getStints: (key: string, driver?: string) =>
    request<StintData[]>(`/sessions/${key}/stints${driver ? `?driver=${driver}` : ''}`),

  /**
   * Per-stint tyre degradation.
   *
   * Pass `detail: 'summary'` for the dashboard panel — it omits per-lap points and curve
   * grids and skips the bootstrap, so a full race costs ~100ms instead of ~3.8s. The
   * analysis page uses `detail: 'full'`, ideally with a `driver` filter.
   */
  getTyreDegradation: (
    key: string,
    params?: {
      driver?: string;
      compound?: string;
      detail?: 'full' | 'summary';
      minLaps?: number;
      bootstrap?: boolean;
      corrections?: string;
    }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.driver) searchParams.set('driver', params.driver);
    if (params?.compound) searchParams.set('compound', params.compound);
    if (params?.detail) searchParams.set('detail', params.detail);
    if (params?.minLaps !== undefined) searchParams.set('min_laps', String(params.minLaps));
    if (params?.bootstrap === false) searchParams.set('bootstrap', 'false');
    // An empty string is meaningful here — it disables every correction — so test for
    // undefined rather than falsiness.
    if (params?.corrections !== undefined) searchParams.set('corrections', params.corrections);
    const qs = searchParams.toString();
    return request<TyreDegradationResponse>(
      `/sessions/${key}/tyre-degradation${qs ? `?${qs}` : ''}`
    );
  },

  // Telemetry
  getTelemetry: (key: string, driver: string, lap: string = 'fastest', downsample?: number) => {
    const params = new URLSearchParams({ driver, lap });
    if (downsample) params.set('downsample', String(downsample));
    return request<TelemetryResponse>(`/sessions/${key}/telemetry?${params}`);
  },

  getTopSpeeds: (key: string, topN?: number) => {
    const params = new URLSearchParams();
    if (topN) params.set('top_n', String(topN));
    return request<TopSpeedsResponse>(`/sessions/${key}/top-speeds?${params}`);
  },

  getCircuitInfo: (key: string) =>
    request<CornerData[]>(`/sessions/${key}/circuit`),

  getRaceControlMessages: (key: string) =>
    request<RaceControlMessage[]>(`/sessions/${key}/race-control-messages`),

  getTeamRadio: (key: string) =>
    request<{ session_key: string, data: RadioMessage[] }>(`/sessions/${key}/radio`),

  // Standings
  getDriverStandings: (year: number, round?: number) => {
    const params = new URLSearchParams({ year: String(year) });
    if (round) params.set('round_number', String(round));
    return request<DriverStanding[]>(`/standings/drivers?${params}`);
  },

  getConstructorStandings: (year: number, round?: number) => {
    const params = new URLSearchParams({ year: String(year) });
    if (round) params.set('round_number', String(round));
    return request<ConstructorStanding[]>(`/standings/constructors?${params}`);
  },

  // Calendar
  getCalendar: (year: number) =>
    request<CalendarEvent[]>(`/calendar?year=${year}`),

  // Panels
  getPanels: () =>
    request<PanelCatalogueItem[]>('/panels'),

  // Ingestion
  ingestSession: (year: number, sessionType: string, roundNumber?: number, event?: string) => {
    const params = new URLSearchParams({ year: String(year), session_type: sessionType });
    if (roundNumber) params.set('round_number', String(roundNumber));
    if (event) params.set('event', event);
    return request<{ status: string }>(`/sessions/ingest?${params}`, { method: 'POST' });
  },

  ingestCalendar: (year: number) =>
    request<{ status: string }>(`/calendar/ingest?year=${year}`, { method: 'POST' }),

  syncSeasonSessions: (year: number) =>
    request<{ status: string }>(`/sessions/sync?year=${year}`, { method: 'POST' }),
};
