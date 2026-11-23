/**
 * Race Replay — the lap laid out as a line around the followed car: half a lap ahead to the
 * right, half a lap behind to the left, with every car at its distance on the road and corner
 * numbers as landmarks. Lapped cars are rings (amber a lap up, blue a lap down); cars in the
 * pit lane drop below the line. Updated every frame.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { Replay } from './decode';
import { wrapHalfLap } from './relative';
import { carOpacity, distanceAt } from './replayMath';
import type { TrackGeometry } from './trackGeometry';
import { arcAtDistance, projectToArc } from './trackGeometry';

interface Props {
  replay: Replay;
  geometry: TrackGeometry;
  subscribe: (cb: (t: number) => void) => () => void;
  focus: string;
  rival: string | null;
  width: number;
  height?: number;
}

const PAD = 14;

export const TrackStrip: React.FC<Props> = ({ replay, geometry, subscribe, focus, rival, width, height = 34 }) => {
  const carRefs = useRef(new Map<string, SVGGElement>());
  const cornerRefs = useRef(new Map<string, SVGGElement>());
  const corners = useMemo(
    () => replay.corners.map(c => ({ key: `${c.number}${c.letter}`, s: projectToArc(geometry, c.x, c.y).s })),
    [replay, geometry]
  );
  const mid = height / 2 - 2;

  useEffect(() => {
    const L = replay.lapLength;
    const span = width / 2 - PAD;
    const toX = (delta: number) => width / 2 + (delta / (L / 2)) * span;
    const focusDrv = replay.byAbbr.get(focus);

    return subscribe(t => {
      if (!focusDrv) return;
      const dF = distanceAt(replay, focusDrv, t);
      const sF = arcAtDistance(geometry, dF);
      const perimeterToLap = L / geometry.perimeter;

      for (const c of corners) {
        const g = cornerRefs.current.get(c.key);
        g?.setAttribute('transform', `translate(${toX(wrapHalfLap((c.s - sF) * perimeterToLap, L)).toFixed(1)},0)`);
      }
      for (const drv of replay.drivers) {
        const g = carRefs.current.get(drv.abbr);
        if (!g) continue;
        if (carOpacity(drv, t) < 1) {
          g.setAttribute('visibility', 'hidden');
          continue;
        }
        const dC = distanceAt(replay, drv, t);
        const delta = wrapHalfLap(dC - dF, L);
        const lapDiff = Math.round((dC - dF - delta) / L);
        const inPit = drv.stops.some(s => s.in_t <= t && (s.out_t == null || t < s.out_t));
        g.setAttribute('visibility', 'visible');
        g.setAttribute('transform', `translate(${toX(delta).toFixed(1)},${inPit ? 9 : 0})`);
        g.setAttribute('data-lap', lapDiff > 0 ? 'up' : lapDiff < 0 ? 'down' : 'same');
      }
    });
  }, [replay, geometry, subscribe, focus, corners, width]);

  return (
    <svg width={width} height={height} style={{ display: 'block' }} className="track-strip">
      <title>Cars on track around the followed driver: half a lap behind (left) to half a lap ahead (right)</title>
      <line x1={PAD} x2={width - PAD} y1={mid} y2={mid} stroke="var(--border-strong)" strokeWidth={2} />
      <text x={PAD} y={height - 1} fontSize={8} fill="var(--text-tertiary)">
        behind
      </text>
      <text x={width - PAD} y={height - 1} fontSize={8} fill="var(--text-tertiary)" textAnchor="end">
        ahead
      </text>
      {corners.map(c => (
        <g
          key={c.key}
          ref={el => {
            if (el) cornerRefs.current.set(c.key, el);
            else cornerRefs.current.delete(c.key);
          }}
        >
          <line y1={mid - 4} y2={mid + 4} stroke="var(--border-strong)" />
          <text y={mid - 7} textAnchor="middle" fontSize={7} fill="var(--text-tertiary)">
            {c.key}
          </text>
        </g>
      ))}
      {[...replay.drivers]
        .sort((a, b) => Number(a.abbr === focus) - Number(b.abbr === focus))
        .map(drv => {
          const big = drv.abbr === focus || drv.abbr === rival;
          return (
            <g
              key={drv.abbr}
              ref={el => {
                if (el) carRefs.current.set(drv.abbr, el);
                else carRefs.current.delete(drv.abbr);
              }}
              visibility="hidden"
              className="track-strip__car"
            >
              <title>{drv.abbr}</title>
              <circle cy={mid} r={big ? 5.5 : 4} fill={drv.colour} stroke="var(--bg-page)" strokeWidth={1} />
              {big && (
                <text y={mid + 15} textAnchor="middle" fontSize={8} fontWeight={700} fill="var(--text-primary)">
                  {drv.abbr}
                </text>
              )}
            </g>
          );
        })}
    </svg>
  );
};
