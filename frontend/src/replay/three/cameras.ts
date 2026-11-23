/**
 * Race Replay 3D — camera shots (pure; world coordinates as in `ribbon.ts`).
 *
 * Positions follow the car rigidly; directions come from the track ahead (an average of the
 * outline's direction over a stretch of track), never from smoothing over time. That makes a
 * shot look the same at 1× and 100×, and after a seek, with no lag or overshoot.
 */

import type { ReplayCorner } from '../../lib/api';
import type { CarPose } from '../carPose';
import type { TrackGeometry } from '../trackGeometry';
import { pointAt, projectToArc, tangentAvg } from '../trackGeometry';
import { toWorld } from './ribbon';

export type Vec3 = [number, number, number];

export interface Shot {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
}

export interface CornerStation {
  key: string;
  /** Arc position of the corner's apex. */
  s: number;
  position: Vec3;
}

const DEFAULT_FOV = 45;
/** A TV station covers the approach to its corner and a little of the exit. */
const TV_BEFORE_M = 300;
const TV_AFTER_M = 120;
/** Stay on the current station this far past its window, so it doesn't flicker at the edges. */
const TV_BUFFER_M = 30;
const TV_STAND_OFF_M = 55;
const TV_HEIGHT_M = 10;
/** The TV camera frames the car about this many metres tall. */
const TV_FRAME_M = 25;

function carWorld(pose: CarPose, k: number, z0: number): Vec3 {
  return toWorld(pose.x, pose.y, pose.z, k, z0);
}

function travel(g: TrackGeometry, pose: CarPose, behind: number, ahead: number): [number, number] {
  return pose.onTrack ? tangentAvg(g, pose.s, behind, ahead) : [Math.cos(pose.heading), Math.sin(pose.heading)];
}

/** High and behind, looking down the road: the classic aerial broadcast shot. */
export function helicopterShot(g: TrackGeometry, pose: CarPose, k: number, z0: number): Shot {
  const [x, y, z] = carWorld(pose, k, z0);
  const [tx, ty] = travel(g, pose, 50, 150);
  return {
    position: [x - tx * 60, y + 80, z + ty * 60],
    target: [x + tx * 20, y, z - ty * 20],
    fov: DEFAULT_FOV,
  };
}

/** Just behind and above the car. */
export function chaseShot(g: TrackGeometry, pose: CarPose, k: number, z0: number): Shot {
  const [x, y, z] = carWorld(pose, k, z0);
  const [tx, ty] = travel(g, pose, 10, 40);
  return {
    position: [x - tx * 12, y + 3.5, z + ty * 12],
    target: [x + tx * 25, y + 1, z - ty * 25],
    fov: 60,
  };
}

/** Looking down on the whole circuit from above its middle. */
export function overviewShot(g: TrackGeometry, k: number, z0: number): Shot {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < g.n; i++) {
    minX = Math.min(minX, g.x[i]);
    maxX = Math.max(maxX, g.x[i]);
    minY = Math.min(minY, g.y[i]);
    maxY = Math.max(maxY, g.y[i]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY);
  const target = toWorld(cx, cy, z0, k, z0);
  return { position: [target[0], span * 0.75, target[2] + span * 0.55], target, fov: DEFAULT_FOV };
}

/** One trackside camera per corner, stood off from the apex on the outside (the label side). */
export function cornerStations(corners: ReplayCorner[], g: TrackGeometry, k: number, z0: number): CornerStation[] {
  return corners.map(c => {
    let dx = c.label_x - c.x;
    let dy = c.label_y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const s = projectToArc(g, c.x, c.y).s;
    const apexZ = pointAt(g, s)[2];
    const pos = toWorld(c.x + dx * TV_STAND_OFF_M, c.y + dy * TV_STAND_OFF_M, apexZ, k, z0);
    pos[1] += TV_HEIGHT_M;
    return { key: `${c.number}${c.letter}`, s, position: pos };
  });
}

function wrapDelta(d: number, perimeter: number): number {
  return ((((d + perimeter / 2) % perimeter) + perimeter) % perimeter) - perimeter / 2;
}

/**
 * The station covering arc position `s`: keep the current one while the car is within its
 * window (plus a buffer), otherwise the one whose corner is next ahead. Null between corners
 * that no station covers.
 */
export function pickStation(
  stations: CornerStation[],
  s: number,
  perimeter: number,
  currentKey: string | null
): CornerStation | null {
  const current = stations.find(st => st.key === currentKey);
  if (current) {
    const rel = wrapDelta(s - current.s, perimeter);
    if (rel >= -TV_BEFORE_M - TV_BUFFER_M && rel <= TV_AFTER_M + TV_BUFFER_M) return current;
  }
  let best: CornerStation | null = null;
  let bestAhead = Infinity;
  for (const st of stations) {
    const rel = wrapDelta(s - st.s, perimeter);
    if (rel < -TV_BEFORE_M || rel > TV_AFTER_M) continue;
    const ahead = -rel; // distance still to go to the apex (negative once past it)
    const score = ahead >= 0 ? ahead : TV_BEFORE_M + -ahead;
    if (score < bestAhead) {
      bestAhead = score;
      best = st;
    }
  }
  return best;
}

/** A fixed trackside camera panning to keep the car framed (narrower lens when it's far away). */
export function tvShot(station: CornerStation, pose: CarPose, k: number, z0: number): Shot {
  const target = carWorld(pose, k, z0);
  const [px, py, pz] = station.position;
  const dist = Math.hypot(target[0] - px, target[1] - py, target[2] - pz);
  const fov = Math.min(Math.max((2 * Math.atan(TV_FRAME_M / 2 / Math.max(dist, 1)) * 180) / Math.PI, 6), 55);
  return { position: [px, py, pz], target, fov };
}
