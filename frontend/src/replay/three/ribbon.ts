/**
 * Race Replay 3D — track mesh geometry as plain arrays (no three.js import, so it is testable).
 *
 * World axes: three.x = map x, three.y = elevation (exaggerated by `k`, measured from the lowest
 * point of the track), three.z = −map y, so looking straight down matches the 2D map.
 */

import type { TrackGeometry } from '../trackGeometry';
import { pointAt, tangentAt } from '../trackGeometry';

/** Track surface width (m). */
export const TRACK_WIDTH_M = 12;
/** How far the side skirts drop below the surface, so a raised section doesn't float. */
const SKIRT_M = 3;

export interface MeshArrays {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Lowest elevation on the outline (0 for a flat replay). */
export function baseElevation(g: TrackGeometry): number {
  if (!g.z) return 0;
  let lo = Infinity;
  for (const z of g.z) lo = Math.min(lo, z);
  return lo;
}

/** Map coordinates → three.js world coordinates. */
export function toWorld(x: number, y: number, z: number, k: number, z0: number): [number, number, number] {
  return [x, (z - z0) * k, -y];
}

/** Averaged unit tangent at outline vertex i (mean of the segments either side). */
function vertexTangent(g: TrackGeometry, i: number): [number, number] {
  const prev = (i - 1 + g.n) % g.n;
  const next = (i + 1) % g.n;
  const tx = g.x[next] - g.x[prev];
  const ty = g.y[next] - g.y[prev];
  const len = Math.hypot(tx, ty) || 1;
  return [tx / len, ty / len];
}

/**
 * Closed ribbon along the outline: two vertices per outline point (left and right edge), two
 * triangles per segment, plus skirts hanging down from both edges.
 */
export function trackRibbon(g: TrackGeometry, k: number, z0: number, width = TRACK_WIDTH_M): MeshArrays {
  const n = g.n;
  const half = width / 2;
  // Per point: left top, right top, left skirt bottom, right skirt bottom.
  const positions = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n; i++) {
    const [tx, ty] = vertexTangent(g, i);
    const nx = -ty;
    const ny = tx;
    const z = g.z ? g.z[i] : 0;
    const edges: [number, number, number][] = [
      [g.x[i] + nx * half, g.y[i] + ny * half, z],
      [g.x[i] - nx * half, g.y[i] - ny * half, z],
    ];
    const verts = [
      toWorld(...edges[0], k, z0),
      toWorld(...edges[1], k, z0),
      toWorld(edges[0][0], edges[0][1], z, k, z0),
      toWorld(edges[1][0], edges[1][1], z, k, z0),
    ];
    verts[2][1] -= SKIRT_M;
    verts[3][1] -= SKIRT_M;
    verts.forEach((v, j) => positions.set(v, (i * 4 + j) * 3));
  }

  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = ((i + 1) % n) * 4;
    // Surface (counter-clockwise seen from above).
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    // Left skirt and right skirt.
    indices.push(a, a + 2, b, b, a + 2, b + 2);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  return { positions, indices: Uint32Array.from(indices) };
}

/** A white bar across the track at the timing line, slightly above the surface. */
export function startLineQuad(g: TrackGeometry, k: number, z0: number, depth = 2, width = TRACK_WIDTH_M): MeshArrays {
  const [x, y, z] = pointAt(g, g.sLine);
  const [tx, ty] = tangentAt(g, g.sLine);
  const nx = -ty;
  const ny = tx;
  const h = width / 2;
  const d = depth / 2;
  const corners: [number, number][] = [
    [x + nx * h - tx * d, y + ny * h - ty * d],
    [x - nx * h - tx * d, y - ny * h - ty * d],
    [x - nx * h + tx * d, y - ny * h + ty * d],
    [x + nx * h + tx * d, y + ny * h + ty * d],
  ];
  const positions = new Float32Array(12);
  corners.forEach(([cx, cy], j) => {
    const w = toWorld(cx, cy, z, k, z0);
    w[1] += 0.05;
    positions.set(w, j * 3);
  });
  return { positions, indices: Uint32Array.from([0, 3, 1, 1, 3, 2]) };
}
