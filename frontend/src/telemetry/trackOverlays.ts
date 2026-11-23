/**
 * Telemetry — lines drawn over the track map for a lap comparison: who was fastest through each
 * minisector, and the stretch of track the charts are zoomed into.
 */

import type { LapComparison } from '../replay/lapReplay';
import { interp } from '../replay/lapReplay';
import type { TrackOverlay } from '../replay/ReplayTrack';

/** Equal-length slices of the lap compared for track dominance. */
export const MINISECTORS = 25;

export interface Minisector {
  from: number;
  to: number;
  /** Key of the lap that took the least time over the slice. */
  fastest: string;
  /** Time (s) the fastest lap gained on the next-best lap here. */
  margin: number;
}

/** Points of the reference lap's racing line (map metres) between two reference distances. */
export function pathBetween(comparison: LapComparison, from: number, to: number): [number, number][] {
  const ref = comparison.series.get(comparison.laps[0].key)!;
  const points: [number, number][] = [[interp(ref.d, ref.x, from), interp(ref.d, ref.y, from)]];
  for (let i = 0; i < ref.d.length; i++) {
    if (ref.d[i] > from && ref.d[i] < to) points.push([ref.x[i], ref.y[i]]);
  }
  points.push([interp(ref.d, ref.x, to), interp(ref.d, ref.y, to)]);
  return points;
}

/** Fastest lap through each minisector, by the time each lap took between its boundaries. */
export function minisectorDominance(comparison: LapComparison, count = MINISECTORS): Minisector[] {
  const { laps, series, lapLength } = comparison;
  const out: Minisector[] = [];
  for (let k = 0; k < count; k++) {
    const from = (lapLength * k) / count;
    const to = (lapLength * (k + 1)) / count;
    const times = laps
      .map(l => {
        const s = series.get(l.key)!;
        return { key: l.key, dt: interp(s.d, s.t, to) - interp(s.d, s.t, from) };
      })
      .sort((a, b) => a.dt - b.dt);
    out.push({ from, to, fastest: times[0].key, margin: times.length > 1 ? times[1].dt - times[0].dt : 0 });
  }
  return out;
}

/** Dominance as map overlays, consecutive minisectors of the same lap merged into one line. */
export function dominanceOverlays(comparison: LapComparison, minisectors: Minisector[]): TrackOverlay[] {
  const colours = new Map(comparison.laps.map(l => [l.key, l.colour]));
  const out: TrackOverlay[] = [];
  let i = 0;
  while (i < minisectors.length) {
    let j = i;
    let gained = minisectors[i].margin;
    while (j + 1 < minisectors.length && minisectors[j + 1].fastest === minisectors[i].fastest) {
      j++;
      gained += minisectors[j].margin;
    }
    const key = minisectors[i].fastest;
    out.push({
      points: pathBetween(comparison, minisectors[i].from, minisectors[j].to),
      colour: colours.get(key) ?? 'var(--text-secondary)',
      title: `${key} fastest here, by ${gained.toFixed(3)} s`,
      width: 6,
    });
    i = j + 1;
  }
  return out;
}
