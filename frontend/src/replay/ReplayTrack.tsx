/**
 * Race Replay — 2D track map, whole-track or following one car.
 *
 * The outline, corners and car markers are rendered by React; everything that moves is updated
 * imperatively from the playback clock's per-frame callback, so twenty cars animate without
 * re-rendering anything. Coordinates arrive rotated to the TV orientation; the fit projection
 * and Y-flip follow TrackMapPanel.
 *
 * Follow mode (`mode="follow"`) is a camera on the same drawing: the world group is translated,
 * scaled and (with `headingUp`) rotated each frame so the followed car sits in the middle with
 * the track ahead pointing up. Strokes don't scale, and cars, labels and corner numbers are
 * counter-scaled and counter-rotated so they stay upright and the same size. Switching car or
 * mode eases the camera over 0.6 s instead of cutting.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { getTrackStatusColour } from '../lib/colours';
import type { Replay } from './decode';
import { carOpacity, distanceAt, leaderCar, positionAt } from './replayMath';
import type { TrackGeometry } from './trackGeometry';
import { arcAtDistance, pointAt, tangentAt, tangentAvg } from './trackGeometry';

interface Props {
  replay: Replay;
  geometry: TrackGeometry;
  subscribe: (cb: (t: number) => void) => () => void;
  width: number;
  height: number;
  mode?: 'fit' | 'follow';
  /** Car the follow cam tracks; the race leader when null. */
  followAbbr?: string | null;
  headingUp?: boolean;
  /** Follow cam: metres of track across the map's shorter side. */
  zoomWindow?: number;
  focus?: string | null;
  rival?: string | null;
  battles?: Set<string>;
  /** Track status kind, to tint the racing line under SC/VSC/red. */
  statusKind?: string | null;
  showLabels?: boolean;
  showCorners?: boolean;
  carRadius?: number;
  onSelect?: (abbr: string, shift: boolean) => void;
  /** Coloured lines drawn over the track (map coordinates, metres), e.g. who was fastest where. */
  overlays?: TrackOverlay[];
}

export interface TrackOverlay {
  points: [number, number][];
  colour: string;
  title?: string;
  /** Stroke width in screen pixels (default: a little wider than the racing line). */
  width?: number;
  opacity?: number;
}

interface Camera {
  /** Screen point (fit coordinates) at the centre of the view. */
  mx: number;
  my: number;
  /** Scale relative to the fit view, and rotation in degrees. */
  k: number;
  theta: number;
}

interface CameraState {
  current: Camera | null;
  key: string;
  from: Camera | null;
  startedAt: number;
}

const TINTED_STATUSES = new Set(['sc', 'vsc', 'vsc_ending', 'red']);
const TWEEN_MS = 600;

function smoothstep(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
}

function lerpCamera(a: Camera, b: Camera, e: number): Camera {
  let dTheta = b.theta - a.theta;
  dTheta = ((((dTheta + 180) % 360) + 360) % 360) - 180; // shortest way round
  return {
    mx: a.mx + (b.mx - a.mx) * e,
    my: a.my + (b.my - a.my) * e,
    k: a.k * Math.pow(b.k / a.k, e),
    theta: a.theta + dTheta * e,
  };
}

export const ReplayTrack: React.FC<Props> = ({
  replay,
  geometry,
  subscribe,
  width,
  height,
  mode = 'fit',
  followAbbr = null,
  headingUp = true,
  zoomWindow = 600,
  focus = null,
  rival = null,
  battles,
  statusKind = null,
  showLabels = true,
  showCorners = true,
  carRadius = 6,
  onSelect,
  overlays,
}) => {
  const worldRef = useRef<SVGGElement>(null);
  const carRefs = useRef(new Map<string, SVGGElement>());
  const cornerRefs = useRef(new Map<string, SVGGElement>());
  const camRef = useRef<CameraState>({ current: null, key: '', from: null, startedAt: 0 });

  const projection = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const include = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const [x, y] of replay.outline) include(x, y);
    if (showCorners) for (const c of replay.corners) include(c.label_x, c.label_y);

    const pad = Math.max(12, Math.min(width, height) * 0.04);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.max(Math.min((width - pad * 2) / rangeX, (height - pad * 2) / rangeY), 1e-6);
    const offsetX = (width - rangeX * scale) / 2;
    const offsetY = (height - rangeY * scale) / 2;
    return {
      /** Screen pixels per metre in the fit view. */
      scale,
      mapX: (x: number) => (x - minX) * scale + offsetX,
      mapY: (y: number) => height - ((y - minY) * scale + offsetY),
    };
  }, [replay, width, height, showCorners]);

  useEffect(() => {
    const { mapX, mapY, scale } = projection;
    const fitCamera: Camera = { mx: width / 2, my: height / 2, k: 1, theta: 0 };
    let raf = 0;
    let lastT = 0;

    const target = (t: number): { cam: Camera; key: string } => {
      if (mode !== 'follow') return { cam: fitCamera, key: 'fit' };
      const drv = (followAbbr ? replay.byAbbr.get(followAbbr) : undefined) ?? leaderCar(replay, t);
      const p = drv ? positionAt(replay, drv, t) : null;
      const prev = camRef.current.current;
      if (!drv || !p) return { cam: prev ?? fitCamera, key: `follow:${drv?.abbr ?? ''}` };
      let theta = 0;
      if (headingUp) {
        const s = arcAtDistance(geometry, distanceAt(replay, drv, t));
        const [tx, ty] = tangentAvg(geometry, s, 10, 60);
        theta = -90 - (Math.atan2(-ty, tx) * 180) / Math.PI;
      }
      const k = Math.min(width, height) / zoomWindow / scale;
      return { cam: { mx: mapX(p[0]), my: mapY(p[1]), k, theta }, key: `follow:${drv.abbr}` };
    };

    const draw = (t: number) => {
      lastT = t;
      const state = camRef.current;
      const { cam: goal, key } = target(t);
      const now = performance.now();
      if (key !== state.key) {
        state.from = state.current ?? goal;
        state.startedAt = now;
        state.key = key;
      }
      const e = smoothstep((now - state.startedAt) / TWEEN_MS);
      const cam = state.from && e < 1 ? lerpCamera(state.from, goal, e) : goal;
      state.current = cam;
      if (e < 1 && !raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          draw(lastT);
        });
      }

      worldRef.current?.setAttribute(
        'transform',
        `translate(${width / 2},${height / 2}) rotate(${cam.theta.toFixed(2)}) scale(${cam.k.toFixed(4)}) translate(${(-cam.mx).toFixed(1)},${(-cam.my).toFixed(1)})`
      );
      const upright = `rotate(${(-cam.theta).toFixed(2)}) scale(${(1 / cam.k).toFixed(4)})`;

      for (const drv of replay.drivers) {
        const g = carRefs.current.get(drv.abbr);
        if (!g) continue;
        const opacity = carOpacity(drv, t);
        const p = positionAt(replay, drv, t);
        if (!p || opacity === 0) {
          g.setAttribute('visibility', 'hidden');
          continue;
        }
        g.setAttribute('visibility', 'visible');
        g.setAttribute('opacity', String(opacity));
        g.setAttribute('transform', `translate(${mapX(p[0]).toFixed(1)},${mapY(p[1]).toFixed(1)}) ${upright}`);
      }
      for (const c of replay.corners) {
        const g = cornerRefs.current.get(`${c.number}${c.letter}`);
        g?.setAttribute('transform', `translate(${mapX(c.label_x).toFixed(1)},${mapY(c.label_y).toFixed(1)}) ${upright}`);
      }
    };

    const unsubscribe = subscribe(draw);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [replay, geometry, subscribe, projection, mode, followAbbr, headingUp, zoomWindow, width, height]);

  const { mapX, mapY } = projection;
  const outlinePoints = useMemo(
    () => replay.outline.map(([x, y]) => `${mapX(x).toFixed(1)},${mapY(y).toFixed(1)}`).join(' '),
    [replay, mapX, mapY]
  );

  // Start/finish: a short bar across the track at the timing line.
  const sf = useMemo(() => {
    const [x0, y0] = pointAt(geometry, geometry.sLine);
    const [tx, ty] = tangentAt(geometry, geometry.sLine);
    const ax = mapX(x0);
    const ay = mapY(y0);
    const dx = mapX(x0 + tx) - ax;
    const dy = mapY(y0 + ty) - ay;
    const len = Math.hypot(dx, dy) || 1;
    const half = 9;
    return { x1: ax - (dy / len) * half, y1: ay + (dx / len) * half, x2: ax + (dy / len) * half, y2: ay - (dx / len) * half };
  }, [geometry, mapX, mapY]);

  const lineColour = statusKind && TINTED_STATUSES.has(statusKind) ? getTrackStatusColour(statusKind) : 'var(--text-tertiary)';

  // Focus and rival last, so they draw on top.
  const drawOrder = useMemo(() => {
    const rank = (abbr: string) => (abbr === focus ? 2 : abbr === rival ? 1 : 0);
    return [...replay.drivers].sort((a, b) => rank(a.abbr) - rank(b.abbr));
  }, [replay, focus, rival]);

  return (
    <svg width={width} height={height} style={{ display: 'block', userSelect: 'none', overflow: 'hidden' }}>
      <g ref={worldRef}>
        <polygon
          points={outlinePoints}
          fill="none"
          stroke="var(--bg-active)"
          strokeWidth={Math.max(6, carRadius * 1.8)}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <polygon
          points={outlinePoints}
          fill="none"
          stroke={lineColour}
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ transition: 'stroke var(--transition-slow)' }}
        />
        {overlays?.map((o, i) => (
          <polyline
            key={i}
            points={o.points.map(([x, y]) => `${mapX(x).toFixed(1)},${mapY(y).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={o.colour}
            strokeWidth={o.width ?? Math.max(4, carRadius)}
            strokeOpacity={o.opacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          >
            {o.title && <title>{o.title}</title>}
          </polyline>
        ))}
        <line {...sf} stroke="var(--text-primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />

        {showCorners &&
          replay.corners.map(c => {
            const text = `${c.number}${c.letter}`;
            return (
              <g key={text} opacity={0.75}>
                <line
                  x1={mapX(c.x)}
                  y1={mapY(c.y)}
                  x2={mapX(c.label_x)}
                  y2={mapY(c.label_y)}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                  strokeDasharray="2,2"
                  vectorEffect="non-scaling-stroke"
                />
                <g
                  ref={el => {
                    if (el) cornerRefs.current.set(text, el);
                    else cornerRefs.current.delete(text);
                  }}
                >
                  <circle r={text.length > 2 ? 9 : 7.5} fill="var(--bg-raised)" stroke="var(--border-strong)" />
                  <text textAnchor="middle" dominantBaseline="central" fill="var(--text-secondary)" fontSize="8px" fontWeight={600}>
                    {text}
                  </text>
                </g>
              </g>
            );
          })}

        {drawOrder.map(drv => {
          const isFocus = drv.abbr === focus;
          const isRival = drv.abbr === rival;
          const inBattle = battles?.has(drv.abbr) ?? false;
          const r = isFocus || isRival ? carRadius + 1.5 : carRadius;
          return (
            <g
              key={drv.abbr}
              ref={el => {
                if (el) carRefs.current.set(drv.abbr, el);
                else carRefs.current.delete(drv.abbr);
              }}
              visibility="hidden"
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={onSelect ? e => onSelect(drv.abbr, e.shiftKey) : undefined}
            >
              <title>{`${drv.abbr} — click to follow, shift-click to compare`}</title>
              {inBattle && (
                <circle r={r + 5} fill="none" stroke="var(--accent-amber)" strokeWidth={1.5} strokeDasharray="3 2" />
              )}
              {isFocus && <circle r={r + 3.5} fill="none" stroke="var(--text-primary)" strokeWidth={2} />}
              {isRival && (
                <circle r={r + 3.5} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} strokeDasharray="2 2" />
              )}
              <circle r={r} fill={drv.colour} stroke="var(--bg-page)" strokeWidth={1.5} />
              {showLabels && (
                <text
                  x={r + 3}
                  y={-r}
                  fontSize={isFocus || isRival ? '11px' : '9.5px'}
                  fontWeight={isFocus || isRival ? 700 : 600}
                  fill="var(--text-primary)"
                  stroke="var(--bg-page)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  style={{ pointerEvents: 'none' }}
                >
                  {drv.abbr}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};
