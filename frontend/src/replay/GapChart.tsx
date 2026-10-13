/**
 * Race Replay — gap to leader, lap by lap.
 *
 * Each line is a driver's time behind the leader as they cross the line, drawn only up to
 * the replay's current moment, so the race history builds as it plays. Safety car, VSC and
 * red flag periods are shaded; the focused driver is drawn bold.
 */

import React, { useMemo } from 'react';
import { getTrackStatusColour } from '../lib/colours';
import type { Replay } from './decode';
import { useElementSize } from './useElementSize';

interface Props {
  replay: Replay;
  time: number;
  lapTicks: { lap: number; t: number }[];
  focus: string | null;
  onSeek: (t: number) => void;
  height?: number;
}

const MARGIN = { left: 34, right: 8, top: 8, bottom: 20 };
const SHADED = new Set(['sc', 'vsc', 'vsc_ending', 'red']);
/** Beyond this the chart is all lapped cars; clip rather than squash the battle for the lead. */
const MAX_GAP_S = 90;

export const GapChart: React.FC<Props> = ({ replay, time, lapTicks, focus, onSeek, height = 220 }) => {
  const [ref, { width }] = useElementSize<HTMLDivElement>();

  const { series, yMax } = useMemo(() => {
    const leaderEnd = new Map(lapTicks.map(l => [l.lap, l.t]));
    const series = replay.drivers.map(drv => {
      const pts: { lap: number; gap: number; t: number }[] = [];
      for (const [lap, row] of drv.laps) {
        const lead = leaderEnd.get(lap);
        if (row.end_t == null || lead == null) continue;
        pts.push({ lap, gap: row.end_t - lead, t: row.end_t });
      }
      pts.sort((a, b) => a.lap - b.lap);
      return { drv, pts };
    });
    const maxGap = Math.max(0, ...series.flatMap(s => s.pts.map(p => p.gap).filter(g => g < MAX_GAP_S)));
    return { series, yMax: Math.min(Math.max(Math.ceil(maxGap / 10) * 10, 10), MAX_GAP_S) };
  }, [replay, lapTicks]);

  // Session time → lap axis: lap n ends at x = n.
  const lapX = useMemo(() => {
    const ends = lapTicks.map(l => l.t);
    return (t: number) => {
      let k = 0;
      while (k < ends.length && ends[k] <= t) k++;
      if (k >= ends.length) return ends.length;
      const prev = k === 0 ? replay.raceStart : ends[k - 1];
      const frac = Math.min(Math.max((t - prev) / (ends[k] - prev || 1), 0), 1);
      return k + frac;
    };
  }, [lapTicks, replay.raceStart]);

  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const sx = (lap: number) => MARGIN.left + (lap / replay.totalLaps) * plotW;
  const sy = (gap: number) => MARGIN.top + (Math.min(gap, yMax) / yMax) * plotH;
  const yStep = yMax <= 20 ? 5 : yMax <= 60 ? 10 : 20;
  const nowX = time < replay.raceStart ? 0 : lapX(time);

  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0 }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          style={{ display: 'block', cursor: 'pointer' }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const lap = Math.round(((e.clientX - rect.left - MARGIN.left) / plotW) * replay.totalLaps);
            const t = lap <= 0 ? replay.raceStart : lapTicks.find(l => l.lap === lap)?.t;
            if (t != null) onSeek(t);
          }}
        >
          <title>Gap to leader at the line · click to jump to that lap</title>
          <defs>
            <clipPath id="gap-chart-plot">
              <rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {replay.trackStatus
            .filter(iv => SHADED.has(iv.kind) && iv.start_t <= time)
            .map(iv => {
              const x0 = sx(lapX(iv.start_t));
              const x1 = sx(lapX(Math.min(iv.end_t, time)));
              return (
                <rect
                  key={`${iv.kind}-${iv.start_t}`}
                  x={x0}
                  y={MARGIN.top}
                  width={Math.max(x1 - x0, 1)}
                  height={plotH}
                  fill={getTrackStatusColour(iv.kind)}
                  opacity={0.12}
                />
              );
            })}

          {Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep).map(g => (
            <g key={`y-${g}`}>
              <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={sy(g)} y2={sy(g)} stroke="var(--border-default)" />
              <text x={MARGIN.left - 6} y={sy(g)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="var(--text-tertiary)">
                {g === 0 ? '0' : `+${g}`}
              </text>
            </g>
          ))}
          {Array.from({ length: Math.floor(replay.totalLaps / 10) + 1 }, (_, i) => i * 10).map(lap => (
            <text key={`x-${lap}`} x={sx(lap)} y={height - 6} textAnchor="middle" fontSize={9} fill="var(--text-tertiary)">
              {lap === 0 ? 'Lap' : lap}
            </text>
          ))}

          <g clipPath="url(#gap-chart-plot)">
            {[...series]
              .sort((a, b) => Number(a.drv.abbr === focus) - Number(b.drv.abbr === focus))
              .map(({ drv, pts }) => {
                const shown = pts.filter(p => p.t <= time);
                if (shown.length < 2) return null;
                const isFocus = drv.abbr === focus;
                return (
                  <polyline
                    key={drv.abbr}
                    points={shown.map(p => `${sx(p.lap).toFixed(1)},${sy(p.gap).toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke={drv.colour}
                    strokeWidth={isFocus ? 2.5 : 1.2}
                    opacity={focus == null ? 0.8 : isFocus ? 1 : 0.25}
                    strokeLinejoin="round"
                  />
                );
              })}
          </g>

          <line
            x1={sx(nowX)}
            x2={sx(nowX)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
            stroke="var(--text-secondary)"
            strokeDasharray="3 3"
          />
        </svg>
      )}
    </div>
  );
};
