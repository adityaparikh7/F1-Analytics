/**
 * Race Replay — per-frame maths.
 *
 * Pure functions over a decoded `Replay`, so they can run every animation frame (positions)
 * or a few times a second (the timing tower) without touching React.
 *
 * Ordering and gaps come from race progress `d` (metres, exactly lap × lap length at each
 * line crossing). The gap between two cars is how long ago the car ahead was where the car
 * behind is now — the same definition the TV timing uses — found by binary search in the car
 * ahead's (non-decreasing) `d` series.
 */

import type { ReplayPitStop, ReplayTrackStatus } from '../lib/api';
import type { Replay, ReplayDriver } from './decode';

export type DriverState = 'grid' | 'running' | 'pit' | 'out' | 'finished';

export type Gap =
  | { kind: 'leader' }
  | { kind: 'time'; seconds: number }
  | { kind: 'laps'; laps: number }
  | null;

export interface StandingRow {
  driver: ReplayDriver;
  position: number;
  d: number;
  /** Lap in progress (the final lap once finished). */
  lap: number;
  gapToLeader: Gap;
  interval: Gap;
  state: DriverState;
  compound: string | null;
  tyreAge: number | null;
  stops: number;
  /** Places gained since the start (positive) or lost (negative). */
  gridDelta: number | null;
}

/** Cars closer than this (seconds) are "in a battle" — DRS range. */
export const BATTLE_THRESHOLD_S = 1.0;

/** Fraction of a lap (~5 m) absorbed when counting whole laps from integer-metre distances. */
const LAP_EPSILON = 1e-3;

/** Retired cars stay on the map, faded, for this long before disappearing. */
export const RETIRED_VISIBLE_S = 30;

// ── Frames ──────────────────────────────────────────────────────────

/** Fractional frame index for session time `t`, clamped to the replay. */
export function frameAt(replay: Replay, t: number): number {
  const f = (t - replay.tStart) * replay.hz;
  return Math.min(Math.max(f, 0), replay.nFrames - 1);
}

/** Linear interpolation of a per-frame series at fractional frame `f`. */
export function sampleAt(series: Float32Array, f: number): number {
  const i = Math.floor(f);
  if (i >= series.length - 1) return series[series.length - 1];
  const a = series[i];
  return a + (series[i + 1] - a) * (f - i);
}

/** Value of a discrete series (gear, brake) at fractional frame `f`. */
export function holdAt(series: Uint8Array | Float32Array, f: number): number {
  return series[Math.min(Math.floor(f), series.length - 1)];
}

/** GPS position, or null where the car has no data at this moment. */
export function positionAt(replay: Replay, drv: ReplayDriver, t: number): [number, number] | null {
  if (drv.x.length === 0) return null;
  const f = frameAt(replay, t);
  if (drv.hidden[Math.round(f)]) return null;
  return [sampleAt(drv.x, f), sampleAt(drv.y, f)];
}

export function distanceAt(replay: Replay, drv: ReplayDriver, t: number): number {
  return sampleAt(drv.d, frameAt(replay, t));
}

/** Earliest session time at which `drv` had covered `dist` metres, or null if it never did. */
export function timeAtDistance(replay: Replay, drv: ReplayDriver, dist: number): number | null {
  const d = drv.d;
  if (d.length === 0 || d[d.length - 1] < dist) return null;
  if (d[0] >= dist) return replay.tStart;
  let lo = 0;
  let hi = d.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] >= dist) hi = mid;
    else lo = mid;
  }
  const span = d[hi] - d[lo];
  const k = span > 0 ? (dist - d[lo]) / span : 0;
  return replay.tStart + (lo + k) / replay.hz;
}

// ── Timelines ───────────────────────────────────────────────────────

export function trackStatusAt(replay: Replay, t: number): ReplayTrackStatus | null {
  for (const iv of replay.trackStatus) {
    if (t >= iv.start_t && t < iv.end_t) return iv;
  }
  return null;
}

/** Number of values in an ascending array that are ≤ t. */
function countUpTo(sorted: Float64Array, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Laps completed at time t. Falls back to race progress if the feed had no lap times. */
export function lapsCompleted(replay: Replay, drv: ReplayDriver, t: number): number {
  if (drv.lapEnds.length > 0) return countUpTo(drv.lapEnds, t);
  return Math.max(0, Math.floor(distanceAt(replay, drv, t) / replay.lapLength + LAP_EPSILON));
}

function activeStop(stops: ReplayPitStop[], t: number): ReplayPitStop | null {
  for (const s of stops) {
    if (s.in_t <= t && (s.out_t == null || t < s.out_t)) return s;
  }
  return null;
}

function tyreAt(drv: ReplayDriver, lap: number): { compound: string | null; age: number | null } {
  for (let n = lap; n >= 1; n--) {
    const row = drv.laps.get(n);
    if (row && row.compound) return { compound: row.compound, age: row.tyre_life };
  }
  return { compound: null, age: null };
}

/** The leader's line crossings, for lap ticks on the scrubber and "jump to lap". */
export function leaderLapEnds(replay: Replay): { lap: number; t: number }[] {
  const first = new Map<number, number>();
  for (const drv of replay.drivers) {
    for (const [lap, row] of drv.laps) {
      if (row.end_t == null) continue;
      const prev = first.get(lap);
      if (prev == null || row.end_t < prev) first.set(lap, row.end_t);
    }
  }
  return [...first.entries()].map(([lap, t]) => ({ lap, t })).sort((a, b) => a.lap - b.lap);
}

/**
 * Red-flag stoppages to skip during playback: from a few seconds after the flag (so the
 * moment is seen) to a few seconds before the restart.
 */
export function redFlagSkips(replay: Replay): [number, number][] {
  return replay.trackStatus
    .filter(iv => iv.kind === 'red' && iv.end_t - iv.start_t > 30)
    .map(iv => [iv.start_t + 8, iv.end_t - 5] as [number, number]);
}

// ── Standings ───────────────────────────────────────────────────────

function gapBetween(replay: Replay, ahead: StandingRow, behind: StandingRow, t: number): Gap {
  if (behind.state === 'out' || ahead.state === 'out') return null;
  const lapsDown = Math.floor((ahead.d - behind.d) / replay.lapLength + LAP_EPSILON);
  if (lapsDown >= 1) return { kind: 'laps', laps: lapsDown };

  const fa = ahead.driver.finishT;
  const fb = behind.driver.finishT;
  if (behind.state === 'finished' && fa != null && fb != null) {
    return { kind: 'time', seconds: Math.max(0, fb - fa) };
  }
  const reached = timeAtDistance(replay, ahead.driver, behind.d);
  if (reached == null) return null;
  return { kind: 'time', seconds: Math.max(0, t - reached) };
}

/**
 * The timing tower at session time `t`.
 *
 * Before lights out the order is the starting grid (pit-lane starters last). Under a red
 * flag the order and gaps are frozen at the moment the flag came out; otherwise "time since
 * the car ahead was here" keeps growing while the cars sit in the pit lane.
 */
export function computeStandings(replay: Replay, t: number): StandingRow[] {
  const status = trackStatusAt(replay, t);
  const tOrder = status?.kind === 'red' ? Math.min(t, status.start_t) : t;
  const preStart = t < replay.raceStart;
  const field = replay.drivers.length;

  const rows: StandingRow[] = replay.drivers.map(drv => {
    const out = drv.retiredT != null && t >= drv.retiredT;
    const finished = drv.finishT != null && tOrder >= drv.finishT;
    const completed = lapsCompleted(replay, drv, tOrder);
    const lap = Math.min(finished ? completed : completed + 1, replay.totalLaps);
    const tyre = tyreAt(drv, Math.max(lap, 1));

    let state: DriverState = 'running';
    if (preStart) state = 'grid';
    else if (out) state = 'out';
    else if (finished) state = 'finished';
    else if (status?.kind !== 'red' && activeStop(drv.stops, t)) state = 'pit';

    return {
      driver: drv,
      position: 0,
      d: distanceAt(replay, drv, tOrder),
      lap,
      gapToLeader: null,
      interval: null,
      state,
      compound: tyre.compound,
      tyreAge: tyre.age,
      stops: drv.stops.filter(s => s.in_t <= t).length,
      gridDelta: null,
    };
  });

  const gridSlot = (drv: ReplayDriver) => (drv.grid && drv.grid > 0 ? drv.grid : field + 1);
  if (preStart) {
    rows.sort((a, b) => gridSlot(a.driver) - gridSlot(b.driver) || Number(a.driver.number) - Number(b.driver.number));
  } else {
    rows.sort(
      (a, b) =>
        Number(a.state === 'out') - Number(b.state === 'out') ||
        b.d - a.d ||
        (a.driver.finishT ?? Infinity) - (b.driver.finishT ?? Infinity) ||
        gridSlot(a.driver) - gridSlot(b.driver)
    );
  }

  rows.forEach((row, i) => {
    row.position = i + 1;
    row.gridDelta = Math.min(gridSlot(row.driver), field) - row.position;
    if (preStart) return;
    if (i === 0) {
      row.gapToLeader = { kind: 'leader' };
      row.interval = { kind: 'leader' };
      return;
    }
    row.gapToLeader = gapBetween(replay, rows[0], row, tOrder);
    row.interval = gapBetween(replay, rows[i - 1], row, tOrder);
  });
  return rows;
}

/** Abbreviations of cars within `threshold` seconds of a running car directly ahead. */
export function battlesAt(rows: StandingRow[], threshold = BATTLE_THRESHOLD_S): Set<string> {
  const inBattle = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ahead = rows[i - 1];
    if (row.state !== 'running' || ahead.state !== 'running') continue;
    if (row.interval?.kind === 'time' && row.interval.seconds < threshold) {
      inBattle.add(row.driver.abbr);
      inBattle.add(ahead.driver.abbr);
    }
  }
  return inBattle;
}

/** Whether a car should be drawn on the map at time t, and how strongly. */
export function carOpacity(drv: ReplayDriver, t: number): number {
  if (drv.retiredT == null || t < drv.retiredT) return 1;
  return t < drv.retiredT + RETIRED_VISIBLE_S ? 0.35 : 0;
}

// ── Formatting ──────────────────────────────────────────────────────

export function formatReplayGap(gap: Gap, leaderLabel = 'Leader'): string {
  if (gap == null) return '';
  if (gap.kind === 'leader') return leaderLabel;
  if (gap.kind === 'laps') return `+${gap.laps} LAP${gap.laps > 1 ? 'S' : ''}`;
  return `+${gap.seconds.toFixed(gap.seconds < 100 ? 3 : 1)}`;
}

/** Race clock: time since lights out, "−0:05" before the start. */
export function formatRaceClock(replay: Replay, t: number): string {
  const s = t - replay.raceStart;
  const sign = s < 0 ? '−' : '';
  const abs = Math.abs(s);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = Math.floor(abs % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${sign}${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
