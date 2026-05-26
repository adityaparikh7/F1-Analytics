/**
 * F1 Pitwall — Typed API Client
 *
 * All backend communication goes through this module.
 * The frontend never reads Parquet or DuckDB directly.
 */

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error ${response.status}: ${error}`);
  }

  return response.json();
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

export interface CornerData {
  number: number;
  letter: string | null;
  angle: number | null;
  distance: number | null;
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

  // Telemetry
  getTelemetry: (key: string, driver: string, lap: string = 'fastest', downsample?: number) => {
    const params = new URLSearchParams({ driver, lap });
    if (downsample) params.set('downsample', String(downsample));
    return request<TelemetryResponse>(`/sessions/${key}/telemetry?${params}`);
  },

  getCircuitInfo: (key: string) =>
    request<CornerData[]>(`/sessions/${key}/circuit`),

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
