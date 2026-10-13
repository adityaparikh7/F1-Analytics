/**
 * Race Replay — payload decoding.
 *
 * The backend sends every per-frame series delta-encoded as integers (a stationary car is a
 * run of zeros, which halves the gzipped size). This turns a payload into typed arrays once,
 * up front, so the per-frame maths in `replayMath.ts` is plain indexing.
 */

import type {
  ReplayCorner,
  ReplayHudPayload,
  ReplayLap,
  ReplayPayload,
  ReplayPitStop,
  ReplayRaceControl,
  ReplayTrackStatus,
} from '../lib/api';
import { adjustColorLightness, getDriverColour } from '../lib/colours';

export interface ReplayDriver {
  number: string;
  abbr: string;
  team: string;
  /** Grid slot; 0 or null is a pit-lane start. */
  grid: number | null;
  finishT: number | null;
  retiredT: number | null;
  colour: string;
  /** Rotated position in metres. */
  x: Float32Array;
  y: Float32Array;
  d: Float32Array;
  /** 1 where the frame has no position data. */
  hidden: Uint8Array;
  /** Session times of real line crossings, ascending; index n-1 is the end of lap n. */
  lapEnds: Float64Array;
  /** Laps by lap number (sparse), for tyre and lap-time lookups. */
  laps: Map<number, ReplayLap>;
  /** Real stops only (red-flag tyre changes excluded), ascending by entry. */
  stops: ReplayPitStop[];
  redFlagStops: ReplayPitStop[];
}

export interface Replay {
  sessionKey: string;
  eventName: string;
  sessionName: string;
  hz: number;
  tStart: number;
  tEnd: number;
  nFrames: number;
  raceStart: number;
  /** When the leader took the chequered flag. */
  finishT: number | null;
  totalLaps: number;
  lapLength: number;
  outline: [number, number][];
  corners: ReplayCorner[];
  drivers: ReplayDriver[];
  byAbbr: Map<string, ReplayDriver>;
  trackStatus: ReplayTrackStatus[];
  raceControl: ReplayRaceControl[];
  pitStops: ReplayPitStop[];
}

export interface DriverHud {
  abbr: string;
  hasDrs: boolean;
  speed: Float32Array;
  throttle: Float32Array;
  brake: Uint8Array;
  gear: Uint8Array;
  drs: Uint8Array;
}

/** Running sum of a delta-encoded series. */
export function decodeDelta<T extends Float32Array | Uint8Array>(
  values: number[] | undefined,
  out: T
): T {
  let acc = 0;
  const n = values?.length ?? 0;
  for (let i = 0; i < n; i++) {
    acc += values![i];
    out[i] = acc;
  }
  return out;
}

function rangesToMask(ranges: [number, number][], n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (const [a, b] of ranges) mask.fill(1, Math.max(0, a), Math.min(n, b));
  return mask;
}

/**
 * Team colour per driver, with the second driver of each team lightened so teammates stay
 * distinguishable on the map. "Second" is by car number, so it is stable across races.
 */
function driverColours(payload: ReplayPayload): Map<string, string> {
  const seen = new Map<string, number>();
  const colours = new Map<string, string>();
  const sorted = [...payload.drivers].sort((a, b) => Number(a.number) - Number(b.number));
  for (const drv of sorted) {
    const base = getDriverColour(drv.abbr, drv.team);
    const count = seen.get(drv.team) ?? 0;
    seen.set(drv.team, count + 1);
    colours.set(drv.abbr, count === 0 ? base : adjustColorLightness(base, 22));
  }
  return colours;
}

export function decodeReplay(payload: ReplayPayload): Replay {
  const n = payload.n_frames;
  const colours = driverColours(payload);
  const laps = payload.laps ?? [];
  const pitStops = payload.pit_stops ?? [];

  const drivers: ReplayDriver[] = payload.drivers.map(drv => {
    const ownLaps = laps.filter(l => l.driver === drv.abbr);
    const lapEnds = Float64Array.from(
      ownLaps
        .filter(l => l.end_t != null)
        .map(l => l.end_t as number)
        .sort((a, b) => a - b)
    );
    const ownStops = pitStops.filter(s => s.driver === drv.abbr);
    return {
      number: drv.number,
      abbr: drv.abbr,
      team: drv.team,
      grid: drv.grid,
      finishT: drv.finish_t,
      retiredT: drv.retired_t,
      colour: colours.get(drv.abbr) ?? getDriverColour(drv.abbr, drv.team),
      x: decodeDelta(drv.x, new Float32Array(n)),
      y: decodeDelta(drv.y, new Float32Array(n)),
      d: decodeDelta(drv.d, new Float32Array(n)),
      hidden: rangesToMask(drv.hidden, n),
      lapEnds,
      laps: new Map(ownLaps.map(l => [l.lap, l])),
      stops: ownStops.filter(s => !s.under_red),
      redFlagStops: ownStops.filter(s => s.under_red),
    };
  });

  return {
    sessionKey: payload.session_key,
    eventName: payload.event_name,
    sessionName: payload.session_name,
    hz: payload.hz,
    tStart: payload.t_start,
    tEnd: payload.t_start + (n - 1) / payload.hz,
    nFrames: n,
    raceStart: payload.race_start_t,
    finishT: payload.finish_t,
    totalLaps: payload.total_laps,
    lapLength: payload.lap_length_m,
    outline: payload.track.outline,
    corners: payload.track.corners,
    drivers,
    byAbbr: new Map(drivers.map(d => [d.abbr, d])),
    trackStatus: payload.track_status,
    raceControl: payload.race_control ?? [],
    pitStops,
  };
}

export function decodeHud(payload: ReplayHudPayload): DriverHud {
  const n = payload.speed.length;
  return {
    abbr: payload.abbr,
    hasDrs: payload.has_drs,
    speed: decodeDelta(payload.speed, new Float32Array(n)),
    throttle: decodeDelta(payload.throttle, new Float32Array(n)),
    brake: decodeDelta(payload.brake, new Uint8Array(n)),
    gear: decodeDelta(payload.gear, new Uint8Array(n)),
    drs: decodeDelta(payload.drs, new Uint8Array(n)),
  };
}
