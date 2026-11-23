/**
 * Race Replay — relative timing and pair gaps.
 *
 * "Relative" is what a driver sees on track rather than the race order: the cars physically
 * nearest, ahead and behind, whatever lap they are on. For car C around the followed car F:
 *
 *  - track separation Δ = d_C − d_F wrapped into [−L/2, L/2): positive means C is ahead on the road;
 *  - lap difference = how many laps C is up (+) or down (−) on F;
 *  - time gap, always taken from the history of the car physically in front, as TV timing does
 *    (so nothing from the future leaks in): for C ahead, how long ago C was where F is now; for C
 *    behind, how long ago F was where C is now. Negative = ahead.
 */

import type { Replay, ReplayDriver } from './decode';
import type { StandingRow } from './replayMath';
import { carOpacity, distanceAt, orderTime, timeAtDistance, trackStatusAt } from './replayMath';

export interface RelativeRow {
  row: StandingRow;
  /** Metres ahead (+) or behind (−) on the road. */
  delta: number;
  /** Laps up (+) or down (−) on the followed car. */
  lapDiff: number;
  /** Seconds, negative when ahead; null when only a distance can be given. */
  gap: number | null;
}

export function wrapHalfLap(x: number, L: number): number {
  return ((((x + L / 2) % L) + L) % L) - L / 2;
}


/** Signed gap between the followed car F and car C, from whichever is physically in front. */
function relativeGap(replay: Replay, f: ReplayDriver, c: ReplayDriver, delta: number, t: number): number | null {
  const dF = distanceAt(replay, f, t);
  const dC = distanceAt(replay, c, t);
  const at = delta >= 0 ? timeAtDistance(replay, c, dC - delta) : timeAtDistance(replay, f, dF + delta);
  if (at == null || at < replay.raceStart) return null;
  return delta >= 0 ? -(t - at) : t - at;
}

/**
 * The followed car and the `each` cars physically nearest ahead of and behind it, ordered from
 * furthest ahead to furthest behind. Cars that are out, finished or not on the map are left out.
 */
export function relativeAt(replay: Replay, rows: StandingRow[], focus: string, t: number, each = 4): RelativeRow[] {
  const fRow = rows.find(r => r.driver.abbr === focus);
  if (!fRow) return [];
  const tc = orderTime(replay, t);
  const L = replay.lapLength;
  const dF = distanceAt(replay, fRow.driver, tc);

  const others: RelativeRow[] = [];
  for (const row of rows) {
    if (row.driver.abbr === focus) continue;
    if (row.state === 'out' || row.state === 'finished' || carOpacity(row.driver, t) === 0) continue;
    const dC = distanceAt(replay, row.driver, tc);
    const delta = wrapHalfLap(dC - dF, L);
    others.push({
      row,
      delta,
      lapDiff: Math.round((dC - dF - delta) / L),
      gap: tc < replay.raceStart ? null : relativeGap(replay, fRow.driver, row.driver, delta, tc),
    });
  }
  const ahead = others.filter(o => o.delta >= 0).sort((a, b) => a.delta - b.delta).slice(0, each).reverse();
  const behind = others.filter(o => o.delta < 0).sort((a, b) => b.delta - a.delta).slice(0, each);
  return [...ahead, { row: fRow, delta: 0, lapDiff: 0, gap: 0 }, ...behind];
}

/**
 * Signed gap from car A to car B at time t: positive when B is behind A (by that many seconds),
 * negative when B is ahead. Measured from the history of whichever car is in front.
 */
export function pairGapAt(replay: Replay, a: ReplayDriver, b: ReplayDriver, t: number): number | null {
  const dA = distanceAt(replay, a, t);
  const dB = distanceAt(replay, b, t);
  if (dA >= dB) {
    const at = timeAtDistance(replay, a, dB);
    return at == null || at < replay.raceStart ? null : t - at;
  }
  const at = timeAtDistance(replay, b, dA);
  return at == null || at < replay.raceStart ? null : -(t - at);
}

export interface PairSeries {
  t: Float64Array;
  /** NaN where no gap could be measured. */
  gap: Float64Array;
}

/** `pairGapAt` sampled every `step` seconds from lights out until either car stops racing. */
export function pairGapSeries(replay: Replay, a: ReplayDriver, b: ReplayDriver, step = 1): PairSeries {
  const ends = [a, b].map(d => d.retiredT ?? d.finishT ?? replay.tEnd);
  const tEnd = Math.min(...ends, replay.tEnd);
  const n = Math.max(0, Math.floor((tEnd - replay.raceStart) / step) + 1);
  const t = new Float64Array(n);
  const gap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = replay.raceStart + i * step;
    const status = trackStatusAt(replay, t[i]);
    const g = status?.kind === 'red' ? NaN : pairGapAt(replay, a, b, t[i]);
    gap[i] = g ?? NaN;
  }
  return { t, gap };
}
