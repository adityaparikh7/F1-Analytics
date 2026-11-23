/**
 * Race Replay — track geometry.
 *
 * The outline as a closed curve parameterised by arc length `s` (metres along the track), so the
 * follow cam, 3D view, track strip and narration can ask "where on the track is race distance d"
 * and "which way does the track go here" without per-frame GPS noise.
 *
 * Two offsets matter:
 *  - The outline starts at the reference lap's first position sample, 9–23 m from the real timing
 *    line, so the line's arc position `sLine` is measured from where cars actually were at their
 *    line crossings (a circular mean, since it may straddle the outline's start).
 *  - The outline's perimeter is ~0.1% shorter than the lap length `L` (10 m chords), so race
 *    distance is mapped by lap fraction: `s = ((d / L) mod 1) · P + sLine`.
 */

import type { Replay } from './decode';
import { positionAt } from './replayMath';

export interface TrackGeometry {
  x: Float64Array;
  y: Float64Array;
  /** Elevation per point, or null for a flat (or pre-v2) replay. */
  z: Float64Array | null;
  /** Arc length at each point; `cum[n]` is the perimeter (closing segment included). */
  cum: Float64Array;
  perimeter: number;
  n: number;
  lapLength: number;
  /** Arc position of the timing line. */
  sLine: number;
}

export interface ArcProjection {
  s: number;
  /** Signed distance from the centreline, positive to the left of the direction of travel. */
  offset: number;
  /** Unsigned distance to the centreline. */
  dist: number;
}

/** Lap ends sampled to locate the timing line; a few hundred is plenty. */
const LINE_SAMPLES = 400;

export function buildGeometry(replay: Replay): TrackGeometry {
  const n = replay.outline.length;
  const x = Float64Array.from(replay.outline, p => p[0]);
  const y = Float64Array.from(replay.outline, p => p[1]);
  const z = replay.elevation ? Float64Array.from(replay.elevation) : null;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(x[j] - x[i], y[j] - y[i]);
  }
  const g: TrackGeometry = { x, y, z, cum, perimeter: cum[n], n, lapLength: replay.lapLength, sLine: 0 };
  g.sLine = timingLineArc(g, replay);
  return g;
}

export function wrapS(g: TrackGeometry, s: number): number {
  return ((s % g.perimeter) + g.perimeter) % g.perimeter;
}

/** Arc position of a car at race distance `d`. */
export function arcAtDistance(g: TrackGeometry, d: number): number {
  const frac = (((d / g.lapLength) % 1) + 1) % 1;
  return wrapS(g, frac * g.perimeter + g.sLine);
}

/** Segment index containing arc position `s` (already wrapped). */
function segmentAt(g: TrackGeometry, s: number): number {
  let lo = 0;
  let hi = g.n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Point on the centreline at arc position `s`: [x, y, elevation]. */
export function pointAt(g: TrackGeometry, s: number): [number, number, number] {
  const w = wrapS(g, s);
  const i = segmentAt(g, w);
  const j = (i + 1) % g.n;
  const len = g.cum[i + 1] - g.cum[i] || 1;
  const k = (w - g.cum[i]) / len;
  const z = g.z ? g.z[i] + (g.z[j] - g.z[i]) * k : 0;
  return [g.x[i] + (g.x[j] - g.x[i]) * k, g.y[i] + (g.y[j] - g.y[i]) * k, z];
}

/** Unit direction of travel of the segment at `s`. */
export function tangentAt(g: TrackGeometry, s: number): [number, number] {
  const i = segmentAt(g, wrapS(g, s));
  const j = (i + 1) % g.n;
  const dx = g.x[j] - g.x[i];
  const dy = g.y[j] - g.y[i];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * Direction of travel averaged from `behind` metres before `s` to `ahead` metres after it:
 * a camera that looks along this turns into corners smoothly instead of snapping per segment.
 */
export function tangentAvg(g: TrackGeometry, s: number, behind: number, ahead: number, step = 5): [number, number] {
  let tx = 0;
  let ty = 0;
  for (let o = -behind; o <= ahead; o += step) {
    const [ax, ay] = tangentAt(g, s + o);
    tx += ax;
    ty += ay;
  }
  const len = Math.hypot(tx, ty) || 1;
  return [tx / len, ty / len];
}

/**
 * Nearest point on the centreline to (px, py). With `around`, only segments within `window`
 * metres of that arc position are searched — faster per frame, and it keeps a car on the right
 * level where the track crosses itself (Suzuka).
 */
export function projectToArc(
  g: TrackGeometry,
  px: number,
  py: number,
  around: number | null = null,
  window = 150
): ArcProjection {
  let best: ArcProjection = { s: 0, offset: 0, dist: Infinity };
  const scan = (i: number) => {
    const j = (i + 1) % g.n;
    const ax = g.x[i];
    const ay = g.y[i];
    const dx = g.x[j] - ax;
    const dy = g.y[j] - ay;
    const len2 = dx * dx + dy * dy || 1;
    const k = Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / len2, 0), 1);
    const qx = ax + dx * k;
    const qy = ay + dy * k;
    const dist = Math.hypot(px - qx, py - qy);
    if (dist < best.dist) {
      const len = Math.sqrt(len2);
      const side = (dx * (py - qy) - dy * (px - qx)) / len;
      best = { s: g.cum[i] + k * (g.cum[i + 1] - g.cum[i]), offset: side, dist };
    }
  };
  if (around == null) {
    for (let i = 0; i < g.n; i++) scan(i);
  } else {
    const first = segmentAt(g, wrapS(g, around - window));
    const count = Math.min(g.n, Math.ceil((2 * window) / (g.perimeter / g.n)) + 2);
    for (let c = 0; c < count; c++) scan((first + c) % g.n);
  }
  return best;
}

/** Circular mean of where cars actually were at their line crossings. */
function timingLineArc(g: TrackGeometry, replay: Replay): number {
  const ends: [ReturnType<typeof replay.drivers.at>, number][] = [];
  for (const drv of replay.drivers) for (const t of drv.lapEnds) ends.push([drv, t]);
  if (ends.length === 0 || g.perimeter <= 0) return 0;
  const stride = Math.max(1, Math.floor(ends.length / LINE_SAMPLES));
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ends.length; i += stride) {
    const [drv, t] = ends[i];
    const p = drv ? positionAt(replay, drv, t) : null;
    if (!p) continue;
    const a = (projectToArc(g, p[0], p[1]).s / g.perimeter) * 2 * Math.PI;
    cx += Math.cos(a);
    cy += Math.sin(a);
  }
  if (cx === 0 && cy === 0) return 0;
  const angle = Math.atan2(cy, cx);
  return wrapS(g, (angle / (2 * Math.PI)) * g.perimeter);
}
