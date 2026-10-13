/**
 * Race Replay — animated track map.
 *
 * The outline, corners and car markers are rendered by React; car positions are then moved
 * imperatively from the playback clock's per-frame callback, so twenty cars animate without
 * re-rendering anything. Fit and Y-flip follow TrackMapPanel; coordinates arrive already
 * rotated to the TV orientation.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { getTrackStatusColour } from '../lib/colours';
import type { Replay } from './decode';
import { carOpacity, positionAt } from './replayMath';

interface Props {
  replay: Replay;
  subscribe: (cb: (t: number) => void) => () => void;
  width: number;
  height: number;
  focus?: string | null;
  battles?: Set<string>;
  /** Track status kind, to tint the racing line under SC/VSC/red. */
  statusKind?: string | null;
  showLabels?: boolean;
  showCorners?: boolean;
  carRadius?: number;
  onSelect?: (abbr: string) => void;
}

const TINTED_STATUSES = new Set(['sc', 'vsc', 'vsc_ending', 'red']);

export const ReplayTrack: React.FC<Props> = ({
  replay,
  subscribe,
  width,
  height,
  focus = null,
  battles,
  statusKind = null,
  showLabels = true,
  showCorners = true,
  carRadius = 6,
  onSelect,
}) => {
  const carRefs = useRef(new Map<string, SVGGElement>());

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
      mapX: (x: number) => (x - minX) * scale + offsetX,
      mapY: (y: number) => height - ((y - minY) * scale + offsetY),
    };
  }, [replay, width, height, showCorners]);

  useEffect(() => {
    const { mapX, mapY } = projection;
    const draw = (t: number) => {
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
        g.setAttribute('transform', `translate(${mapX(p[0]).toFixed(1)},${mapY(p[1]).toFixed(1)})`);
      }
    };
    return subscribe(draw);
  }, [replay, subscribe, projection]);

  const { mapX, mapY } = projection;
  const outlinePoints = useMemo(
    () => replay.outline.map(([x, y]) => `${mapX(x).toFixed(1)},${mapY(y).toFixed(1)}`).join(' '),
    [replay, mapX, mapY]
  );

  // Start/finish: a short bar across the track at the reference lap's first sample.
  const sf = useMemo(() => {
    const [x0, y0] = replay.outline[0];
    const [x1, y1] = replay.outline[Math.min(1, replay.outline.length - 1)];
    const ax = mapX(x0);
    const ay = mapY(y0);
    const dx = mapX(x1) - ax;
    const dy = mapY(y1) - ay;
    const len = Math.hypot(dx, dy) || 1;
    const half = 9;
    return { x1: ax - (dy / len) * half, y1: ay + (dx / len) * half, x2: ax + (dy / len) * half, y2: ay - (dx / len) * half };
  }, [replay, mapX, mapY]);

  const lineColour = statusKind && TINTED_STATUSES.has(statusKind) ? getTrackStatusColour(statusKind) : 'var(--text-tertiary)';

  // Focused car last, so it draws on top.
  const drawOrder = useMemo(
    () => [...replay.drivers].sort((a, b) => Number(a.abbr === focus) - Number(b.abbr === focus)),
    [replay, focus]
  );

  return (
    <svg width={width} height={height} style={{ display: 'block', userSelect: 'none' }}>
      <polygon
        points={outlinePoints}
        fill="none"
        stroke="var(--bg-active)"
        strokeWidth={Math.max(6, carRadius * 1.8)}
        strokeLinejoin="round"
      />
      <polygon
        points={outlinePoints}
        fill="none"
        stroke={lineColour}
        strokeWidth={1.5}
        strokeLinejoin="round"
        style={{ transition: 'stroke var(--transition-slow)' }}
      />
      <line {...sf} stroke="var(--text-primary)" strokeWidth={2.5} />

      {showCorners &&
        replay.corners.map(c => {
          const cx = mapX(c.x);
          const cy = mapY(c.y);
          const lx = mapX(c.label_x);
          const ly = mapY(c.label_y);
          const text = `${c.number}${c.letter}`;
          return (
            <g key={text} opacity={0.75}>
              <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2,2" />
              <circle cx={lx} cy={ly} r={text.length > 2 ? 9 : 7.5} fill="var(--bg-raised)" stroke="var(--border-strong)" />
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--text-secondary)"
                fontSize="8px"
                fontWeight={600}
              >
                {text}
              </text>
            </g>
          );
        })}

      {drawOrder.map(drv => {
        const isFocus = drv.abbr === focus;
        const inBattle = battles?.has(drv.abbr) ?? false;
        const r = isFocus ? carRadius + 1.5 : carRadius;
        return (
          <g
            key={drv.abbr}
            ref={el => {
              if (el) carRefs.current.set(drv.abbr, el);
              else carRefs.current.delete(drv.abbr);
            }}
            visibility="hidden"
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            onClick={onSelect ? () => onSelect(drv.abbr) : undefined}
          >
            <title>{drv.abbr}</title>
            {inBattle && (
              <circle r={r + 5} fill="none" stroke="var(--accent-amber)" strokeWidth={1.5} strokeDasharray="3 2" />
            )}
            {isFocus && <circle r={r + 3.5} fill="none" stroke="var(--text-primary)" strokeWidth={2} />}
            <circle r={r} fill={drv.colour} stroke="var(--bg-page)" strokeWidth={1.5} />
            {showLabels && (
              <text
                x={r + 3}
                y={-r}
                fontSize={isFocus ? '11px' : '9.5px'}
                fontWeight={isFocus ? 700 : 600}
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
    </svg>
  );
};
