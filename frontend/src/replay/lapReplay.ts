/**
 * Race Replay — laps as a replay.
 *
 * Turns two to four single-lap telemetry traces (see `api.getLapTrace`) into the same `Replay`
 * shape a whole race decodes to, so the replay engine's map, follow cam, 3D view, playback clock
 * and HUD readouts can race laps against each other: every lap is a car that crosses the line at
 * t = 0, on a common 10 Hz clock.
 *
 * The first trace is the reference. Lap distances (integrated from speed) differ by a few metres
 * between laps, so every trace's distance is scaled to the reference lap's length; deltas then
 * compare the same point on track. The track outline, elevation and corners come from the
 * reference lap too.
 */

import type { LapTrace } from '../lib/api';
import type { DriverHud, Replay, ReplayDriver } from './decode';

export interface CompareLap {
  /** Unique id and on-map label, e.g. "VER L16". */
  key: string;
  colour: string;
  trace: LapTrace;
}

/** One lap's own samples, distance scaled to the reference lap. */
export interface LapSeries {
  t: Float64Array;
  /** Normalised distance (m). */
  d: Float64Array;
  speed: Float64Array;
  throttle: Float64Array;
  brake: Float64Array;
  gear: Float64Array;
  rpm: Float64Array;
  x: Float64Array;
  y: Float64Array;
}

export interface LapComparison {
  replay: Replay;
  huds: Map<string, DriverHud>;
  laps: CompareLap[];
  series: Map<string, LapSeries>;
  /** Reference lap length (m). */
  lapLength: number;
  /** Lap time of each lap (s); the end of its own lap. */
  lapTimes: Map<string, number>;
  /** Reference distances where sector 1 and sector 2 end. */
  sectorEnds: number[];
  /** Time lost (+) or gained (−) to the reference, on a distance grid. */
  delta: { d: Float64Array; byLap: Map<string, Float64Array> };
}

const HZ = 10;
const OUTLINE_STEP_M = 10;
const ELEVATION_SMOOTH_POINTS = 2; // ±20 m at 10 m spacing
const MIN_ELEVATION_RANGE_M = 1;
const DELTA_STEP_M = 5;

/** Linear interpolation of ascending `xs` → `ys` at `x`, clamped to the ends. */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  return span > 0 ? ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span : ys[lo];
}

/** Value of the latest sample at or before `x` (gear, brake, DRS). */
function hold(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[hi]) return ys[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo];
}

/** Rows where time and position are known, as typed arrays (other gaps filled from neighbours). */
function cleanSamples(trace: LapTrace) {
  const s = trace.samples;
  const keep: number[] = [];
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] != null && s.x[i] != null && s.y[i] != null && s.d[i] != null) {
      if (keep.length && (s.t[i] as number) <= (s.t[keep[keep.length - 1]] as number)) continue;
      keep.push(i);
    }
  }
  const col = (values: (number | null)[]) => {
    const out = new Float64Array(keep.length);
    let last = 0;
    keep.forEach((i, j) => {
      const v = values[i];
      last = v == null || !Number.isFinite(v) ? last : v;
      out[j] = last;
    });
    return out;
  };
  return {
    t: col(s.t),
    d: col(s.d),
    x: col(s.x),
    y: col(s.y),
    z: col(s.z),
    speed: col(s.speed),
    throttle: col(s.throttle),
    brake: col(s.brake),
    gear: col(s.gear),
    rpm: col(s.rpm),
    drs: col(s.drs),
  };
}

/** The reference lap resampled every ~10 m: the track outline, with smoothed elevation. */
function outlineFrom(x: Float64Array, y: Float64Array, z: Float64Array) {
  const n = x.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const pts: [number, number][] = [];
  const heights: number[] = [];
  for (let at = 0; at < s[n - 1]; at += OUTLINE_STEP_M) {
    pts.push([interp(s, x, at), interp(s, y, at)]);
    heights.push(interp(s, z, at));
  }
  const m = heights.length;
  const smooth = Float32Array.from(heights, (_, i) => {
    let sum = 0;
    for (let k = -ELEVATION_SMOOTH_POINTS; k <= ELEVATION_SMOOTH_POINTS; k++) sum += heights[(i + k + m) % m];
    return sum / (2 * ELEVATION_SMOOTH_POINTS + 1);
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of smooth) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return { outline: pts, elevation: hi - lo >= MIN_ELEVATION_RANGE_M ? smooth : null };
}

export function buildLapComparison(
  laps: CompareLap[],
  meta: { sessionKey: string; eventName: string; sessionName: string }
): LapComparison {
  const cleaned = laps.map(l => ({ lap: l, s: cleanSamples(l.trace) }));
  const ref = cleaned[0];
  const lapLength = ref.s.d[ref.s.d.length - 1] - ref.s.d[0] || 1;

  const lapTimes = new Map<string, number>();
  const series = new Map<string, LapSeries>();
  for (const { lap, s } of cleaned) {
    const own = s.d[s.d.length - 1] - s.d[0] || 1;
    const scale = lapLength / own;
    const d = Float64Array.from(s.d, v => (v - s.d[0]) * scale);
    series.set(lap.key, { t: s.t, d, speed: s.speed, throttle: s.throttle, brake: s.brake, gear: s.gear, rpm: s.rpm, x: s.x, y: s.y });
    lapTimes.set(lap.key, lap.trace.lap_time ?? s.t[s.t.length - 1]);
  }

  const tEnd = Math.max(...lapTimes.values()) + 0.5;
  const nFrames = Math.floor(tEnd * HZ) + 1;
  const grid = Float64Array.from({ length: nFrames }, (_, i) => i / HZ);

  const huds = new Map<string, DriverHud>();
  const drivers: ReplayDriver[] = cleaned.map(({ lap, s }) => {
    const ser = series.get(lap.key)!;
    const lapTime = lapTimes.get(lap.key)!;
    const at = (values: ArrayLike<number>, i: number) => interp(s.t, values, grid[i]);
    const held = (values: ArrayLike<number>, i: number) => hold(s.t, values, grid[i]);
    huds.set(lap.key, {
      abbr: lap.key,
      hasDrs: s.drs.some(v => v > 0),
      speed: Float32Array.from(grid, (_, i) => at(s.speed, i)),
      rpm: Float32Array.from(grid, (_, i) => at(s.rpm, i)),
      throttle: Float32Array.from(grid, (_, i) => at(s.throttle, i)),
      brake: Uint8Array.from(grid, (_, i) => (held(s.brake, i) > 0 ? 1 : 0)),
      gear: Uint8Array.from(grid, (_, i) => held(s.gear, i)),
      drs: Uint8Array.from(grid, (_, i) => (held(s.drs, i) > 0 ? 1 : 0)),
    });
    const t = lap.trace;
    return {
      number: t.driver_number,
      abbr: lap.key,
      team: t.team ?? '',
      grid: null,
      finishT: lapTime,
      retiredT: null,
      colour: lap.colour,
      x: Float32Array.from(grid, (_, i) => at(s.x, i)),
      y: Float32Array.from(grid, (_, i) => at(s.y, i)),
      d: Float32Array.from(grid, (_, i) => interp(s.t, ser.d, grid[i])),
      hidden: new Uint8Array(nFrames),
      lapEnds: Float64Array.from([lapTime]),
      laps: new Map([
        [1, { driver: lap.key, lap: 1, end_t: lapTime, lap_time: t.lap_time, position: null, compound: t.compound, tyre_life: t.tyre_life, stint: null }],
      ]),
      stops: [],
      redFlagStops: [],
    };
  });

  const { outline, elevation } = outlineFrom(ref.s.x, ref.s.y, ref.s.z);
  const replay: Replay = {
    version: 2,
    sessionKey: meta.sessionKey,
    eventName: meta.eventName,
    sessionName: meta.sessionName,
    hz: HZ,
    tStart: 0,
    tEnd: (nFrames - 1) / HZ,
    nFrames,
    raceStart: 0,
    finishT: Math.min(...lapTimes.values()),
    totalLaps: 1,
    lapLength,
    outline,
    elevation,
    corners: laps[0].trace.corners,
    drivers,
    byAbbr: new Map(drivers.map(d => [d.abbr, d])),
    trackStatus: [],
    raceControl: [],
    pitStops: [],
  };

  // Time to each point of the lap, against the reference's.
  const refSeries = series.get(laps[0].key)!;
  const dGrid = Float64Array.from({ length: Math.floor(lapLength / DELTA_STEP_M) + 1 }, (_, i) => i * DELTA_STEP_M);
  const refTimes = Float64Array.from(dGrid, x => interp(refSeries.d, refSeries.t, x));
  const byLap = new Map<string, Float64Array>();
  for (const lap of laps) {
    const ser = series.get(lap.key)!;
    byLap.set(lap.key, Float64Array.from(dGrid, (x, i) => interp(ser.d, ser.t, x) - refTimes[i]));
  }

  const sectors = laps[0].trace.sectors;
  const sectorEnds: number[] = [];
  if (sectors[0] != null) {
    sectorEnds.push(interp(refSeries.t, refSeries.d, sectors[0]));
    if (sectors[1] != null) sectorEnds.push(interp(refSeries.t, refSeries.d, sectors[0] + sectors[1]));
  }

  return { replay, huds, laps, series, lapLength, lapTimes, sectorEnds, delta: { d: dGrid, byLap } };
}
