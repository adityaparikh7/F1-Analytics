/**
 * Race Replay — head-to-head: the gap between two drivers over the whole race, drawn up to the
 * replay's current moment, with their stints and pit stops on the same time axis.
 *
 * Above the zero line the first driver is ahead (shaded in their colour), below it the second.
 * Safety car, VSC and red flag periods are shaded; red flags break the line (no meaningful gap).
 * Click anywhere to jump there.
 */

import React, { useMemo } from 'react';
import { ensureReadable, getCompoundColour, getTrackStatusColour, withAlpha } from '../lib/colours';
import type { Replay, ReplayDriver } from './decode';
import { pairGapAt, pairGapSeries } from './relative';
import { useElementSize } from './useElementSize';

interface Props {
  replay: Replay;
  a: string;
  b: string;
  time: number;
  lapTicks: { lap: number; t: number }[];
  onSeek: (t: number) => void;
  height?: number;
}

const M = { left: 38, right: 8, top: 22, bottom: 8 };
const STINT_ROW = 7;
const SHADED = new Set(['sc', 'vsc', 'vsc_ending', 'red']);

interface Stint {
  start: number;
  end: number;
  compound: string | null;
}

function stints(replay: Replay, drv: ReplayDriver): Stint[] {
  const laps = [...drv.laps.values()].filter(l => l.end_t != null).sort((x, y) => x.lap - y.lap);
  const out: Stint[] = [];
  let prevEnd = replay.raceStart;
  for (const lap of laps) {
    const last = out[out.length - 1];
    if (last && last.compound === lap.compound && drv.laps.get(lap.lap - 1)?.stint === lap.stint) last.end = lap.end_t!;
    else out.push({ start: prevEnd, end: lap.end_t!, compound: lap.compound });
    prevEnd = lap.end_t!;
  }
  return out;
}

function describe(a: string, b: string, gap: number | null): string {
  if (gap == null) return `${a} vs ${b}`;
  const s = Math.abs(gap).toFixed(Math.abs(gap) < 100 ? 3 : 1);
  return gap >= 0 ? `${a} leads ${b} by ${s} s` : `${b} leads ${a} by ${s} s`;
}

export const HeadToHead: React.FC<Props> = ({ replay, a, b, time, lapTicks, onSeek, height = 260 }) => {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const A = replay.byAbbr.get(a);
  const B = replay.byAbbr.get(b);

  const series = useMemo(() => (A && B ? pairGapSeries(replay, A, B, 1) : null), [replay, A, B]);
  const yMax = useMemo(() => {
    if (!series) return 5;
    const abs = Array.from(series.gap).filter(Number.isFinite).map(Math.abs).sort((x, y) => x - y);
    const p95 = abs.length ? abs[Math.floor(abs.length * 0.95)] : 5;
    return Math.min(Math.max(Math.ceil(p95 / 5) * 5, 2), 60);
  }, [series]);
  const stintRows = useMemo(() => (A && B ? [stints(replay, A), stints(replay, B)] : [[], []]), [replay, A, B]);

  if (!A || !B || !series) return null;

  const tEnd = series.t.length ? series.t[series.t.length - 1] : replay.tEnd;
  const plotW = Math.max(width - M.left - M.right, 10);
  const plotH = height - M.top - M.bottom - STINT_ROW * 2 - 10;
  const x = (t: number) => M.left + ((t - replay.raceStart) / Math.max(tEnd - replay.raceStart, 1)) * plotW;
  const y = (g: number) => M.top + plotH / 2 - (Math.max(-yMax, Math.min(yMax, g)) / yMax) * (plotH / 2);
  const zeroY = y(0);
  const nowX = Math.min(Math.max(x(time), M.left), M.left + plotW);

  // The gap line, broken where it couldn't be measured (red flags).
  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < series.t.length; i += 2) {
    const g = series.gap[i];
    if (!Number.isFinite(g)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${x(series.t[i]).toFixed(1)},${y(g).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));

  const now = pairGapAt(replay, A, B, Math.min(time, tEnd));
  const colourA = ensureReadable(A.colour);
  const colourB = ensureReadable(B.colour);
  const stintTop = M.top + plotH + 8;

  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 4, fontSize: 'var(--fs-sm)' }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: colourA }} />
        <b>{a}</b>
        <span style={{ color: 'var(--text-tertiary)' }}>vs</span>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: colourB }} />
        <b>{b}</b>
        <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>
          {time < replay.raceStart ? 'Before the start' : describe(a, b, now)}
        </span>
      </div>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          style={{ display: 'block', cursor: 'pointer' }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const k = (e.clientX - rect.left - M.left) / plotW;
            if (k >= 0 && k <= 1) onSeek(replay.raceStart + k * (tEnd - replay.raceStart));
          }}
        >
          <title>Gap between the two drivers · click to jump there</title>
          <defs>
            <clipPath id="h2h-revealed">
              <rect x={M.left} y={0} width={Math.max(nowX - M.left, 0)} height={height} />
            </clipPath>
            <clipPath id="h2h-above">
              <rect x={M.left} y={M.top} width={plotW} height={zeroY - M.top} />
            </clipPath>
            <clipPath id="h2h-below">
              <rect x={M.left} y={zeroY} width={plotW} height={M.top + plotH - zeroY} />
            </clipPath>
          </defs>

          {replay.trackStatus
            .filter(iv => SHADED.has(iv.kind) && iv.end_t > replay.raceStart && iv.start_t < tEnd)
            .map(iv => (
              <rect
                key={`${iv.kind}-${iv.start_t}`}
                x={x(Math.max(iv.start_t, replay.raceStart))}
                y={M.top}
                width={Math.max(x(Math.min(iv.end_t, tEnd)) - x(Math.max(iv.start_t, replay.raceStart)), 1)}
                height={plotH}
                fill={getTrackStatusColour(iv.kind)}
                opacity={0.1}
              />
            ))}

          {[yMax, yMax / 2, 0, -yMax / 2, -yMax].map(g => (
            <g key={g}>
              <line x1={M.left} x2={M.left + plotW} y1={y(g)} y2={y(g)} stroke={g === 0 ? 'var(--border-strong)' : 'var(--border-default)'} />
              <text x={M.left - 5} y={y(g)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="var(--text-tertiary)">
                {g === 0 ? '0' : `${Math.abs(g)}`}
              </text>
            </g>
          ))}
          <text x={M.left + 4} y={M.top + 9} fontSize={9} fill={colourA}>
            {a} ahead
          </text>
          <text x={M.left + 4} y={M.top + plotH - 3} fontSize={9} fill={colourB}>
            {b} ahead
          </text>
          {lapTicks
            .filter(l => l.lap % 10 === 0 && l.t <= tEnd)
            .map(l => (
              <text key={l.lap} x={x(l.t)} y={M.top - 6} textAnchor="middle" fontSize={9} fill="var(--text-tertiary)">
                L{l.lap}
              </text>
            ))}

          <g clipPath="url(#h2h-revealed)">
            {segments.map((pts, i) => {
              const first = pts.slice(0, pts.indexOf(','));
              const last = pts.slice(pts.lastIndexOf(' ') + 1, pts.lastIndexOf(','));
              const area = `${first},${zeroY} ${pts} ${last},${zeroY}`;
              return (
                <g key={i}>
                  <polygon points={area} fill={withAlpha(colourA, 0.25)} clipPath="url(#h2h-above)" />
                  <polygon points={area} fill={withAlpha(colourB, 0.25)} clipPath="url(#h2h-below)" />
                  <polyline points={pts} fill="none" stroke="var(--text-primary)" strokeWidth={1.2} strokeLinejoin="round" />
                </g>
              );
            })}
          </g>

          {[A, B].map((drv, row) =>
            drv.stops.map(stop => (
              <path
                key={`${drv.abbr}-${stop.in_t}`}
                d={
                  row === 0
                    ? `M${x(stop.in_t) - 4},${M.top} l4,6 l4,-6 z`
                    : `M${x(stop.in_t) - 4},${M.top + plotH} l4,-6 l4,6 z`
                }
                fill={row === 0 ? colourA : colourB}
              >
                <title>{`${drv.abbr} pit stop, lap ${stop.lap}`}</title>
              </path>
            ))
          )}

          {stintRows.map((row, i) =>
            row.map(st => (
              <rect
                key={`${i}-${st.start}`}
                x={x(st.start)}
                y={stintTop + i * (STINT_ROW + 2)}
                width={Math.max(x(Math.min(st.end, tEnd)) - x(st.start) - 1, 1)}
                height={STINT_ROW}
                rx={2}
                fill={getCompoundColour(st.compound)}
                opacity={st.start <= time ? 0.9 : 0.25}
              >
                <title>{`${i === 0 ? a : b}: ${st.compound?.toLowerCase() ?? 'unknown'} tyres`}</title>
              </rect>
            ))
          )}

          <line x1={nowX} x2={nowX} y1={M.top} y2={stintTop + STINT_ROW * 2 + 2} stroke="var(--text-secondary)" strokeDasharray="3 3" />
        </svg>
      )}
    </div>
  );
};
