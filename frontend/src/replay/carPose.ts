/**
 * Race Replay — smoothed car pose for cameras and the 3D view.
 *
 * Raw positions are whole metres at 4 Hz: fine for a dot on a map, but a camera locked to them
 * wobbles. On track a car is instead placed in track coordinates — along the outline at its race
 * distance, plus its sideways offset from the centreline averaged over five frames — and points
 * along the track there. Off the outline (pit lane, run-off) raw positions are used, with the
 * heading from its motion and the height of the nearest piece of track (searched near the car's
 * own arc position, so a crossover like Suzuka's resolves to the right level).
 */

import type { Replay, ReplayDriver } from './decode';
import { distanceAt, positionAt } from './replayMath';
import type { TrackGeometry } from './trackGeometry';
import { arcAtDistance, pointAt, projectToArc, tangentAt, tangentAvg } from './trackGeometry';

export interface CarPose {
  x: number;
  y: number;
  /** Elevation (m); 0 when the replay has none. */
  z: number;
  /** Direction of travel, radians in the map's x/y plane. */
  heading: number;
  /** Arc position along the outline. */
  s: number;
  onTrack: boolean;
}

/** Beyond this distance from the centreline a car is off the outline (pit lane, run-off). */
const ON_TRACK_M = 20;
/** Frames either side averaged for the sideways offset. */
const OFFSET_FRAMES = 2;

export function carPose(replay: Replay, g: TrackGeometry, drv: ReplayDriver, t: number): CarPose | null {
  const raw = positionAt(replay, drv, t);
  if (!raw) return null;
  const s = arcAtDistance(g, distanceAt(replay, drv, t));
  const here = projectToArc(g, raw[0], raw[1], s);

  if (here.dist <= ON_TRACK_M) {
    let offset = 0;
    let n = 0;
    for (let k = -OFFSET_FRAMES; k <= OFFSET_FRAMES; k++) {
      const p = positionAt(replay, drv, t + k / replay.hz);
      if (!p) continue;
      const proj = projectToArc(g, p[0], p[1], s, 60);
      if (proj.dist > ON_TRACK_M) continue;
      offset += proj.offset;
      n++;
    }
    offset = n ? offset / n : here.offset;
    const [cx, cy, z] = pointAt(g, s);
    const [tx, ty] = tangentAt(g, s);
    const [hx, hy] = tangentAvg(g, s, 5, 15);
    return { x: cx - ty * offset, y: cy + tx * offset, z, heading: Math.atan2(hy, hx), s, onTrack: true };
  }

  const before = positionAt(replay, drv, t - 0.5) ?? raw;
  const after = positionAt(replay, drv, t + 0.5) ?? raw;
  const moving = Math.hypot(after[0] - before[0], after[1] - before[1]) > 1;
  const [tx, ty] = tangentAt(g, here.s);
  const heading = moving ? Math.atan2(after[1] - before[1], after[0] - before[0]) : Math.atan2(ty, tx);
  return { x: raw[0], y: raw[1], z: pointAt(g, here.s)[2], heading, s: here.s, onTrack: false };
}
