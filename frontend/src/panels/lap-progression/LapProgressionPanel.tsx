/**
 * F1 Pitwall — Lap Time Progression Panel
 *
 * Lap-by-lap line chart for all drivers across a session.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { LapData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';
import { formatLapTime } from '../../lib/format';

const LapProgressionPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [laps, setLaps] = useState<LapData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDriver, setHoveredDriver] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getLaps(sessionKey, { exclude_pit_laps: true })
      .then(data => { setLaps(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  const { driverLaps, drivers, minTime, maxTime, maxLap } = useMemo(() => {
    const map = new Map<string, { laps: Array<{ lap: number; time: number }>; team: string | null }>();
    for (const lap of laps) {
      if (lap.lap_time == null || lap.lap_time <= 0) continue;
      if (!map.has(lap.driver)) map.set(lap.driver, { laps: [], team: lap.team });
      map.get(lap.driver)!.laps.push({ lap: lap.lap_number, time: lap.lap_time });
    }
    const allTimes = laps.filter(l => l.lap_time != null && l.lap_time > 0).map(l => l.lap_time!);
    const sorted = [...allTimes].sort((a, b) => a - b);
    const p5 = sorted[Math.floor(sorted.length * 0.05)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 200;
    return {
      driverLaps: map,
      drivers: Array.from(map.keys()),
      minTime: p5,
      maxTime: p95,
      maxLap: Math.max(...laps.map(l => l.lap_number), 1),
    };
  }, [laps]);

  if (!sessionKey) return <div className="state-empty">Select a session to view lap progression</div>;
  if (loading) return <div className="state-loading"><div className="skeleton skeleton--bar" /><div className="skeleton skeleton--bar" /></div>;
  if (error) return <div className="state-error">{error}</div>;
  if (drivers.length === 0) return <div className="state-empty">No lap data available</div>;

  const chartW = Math.max(width - 20, 300);
  const chartH = Math.max(height - 20, 200);
  const padL = 55, padT = 10, padR = 30, padB = 25;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const timeRange = maxTime - minTime || 1;
  const xScale = (lap: number) => padL + ((lap - 1) / (maxLap - 1 || 1)) * plotW;
  const yScale = (time: number) => padT + ((time - minTime) / timeRange) * plotH;

  return (
    <svg width={chartW} height={chartH} style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
      {/* Gridlines */}
      {Array.from({ length: 5 }, (_, i) => minTime + (timeRange * i) / 4).map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={yScale(t)} x2={padL + plotW} y2={yScale(t)} stroke="var(--border-default)" strokeDasharray="2,4" />
          <text x={padL - 4} y={yScale(t) + 3} fill="var(--text-tertiary)" textAnchor="end" fontSize={9}>{formatLapTime(t)}</text>
        </g>
      ))}
      {/* Lap axis */}
      {Array.from({ length: Math.min(Math.ceil(maxLap / 10), 8) + 1 }, (_, i) => Math.max(i * 10, 1)).map(lap => (
        <text key={lap} x={xScale(lap)} y={chartH - 4} fill="var(--text-tertiary)" textAnchor="middle" fontSize={9}>L{lap}</text>
      ))}
      {/* Driver lines */}
      {drivers.map(driver => {
        const data = driverLaps.get(driver)!;
        const colour = getDriverColour(driver, data.team);
        const isHovered = hoveredDriver === driver;
        const isOther = hoveredDriver != null && !isHovered;
        const filtered = data.laps.filter(d => d.time >= minTime && d.time <= maxTime).sort((a, b) => a.lap - b.lap);
        const pathData = filtered.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.lap)} ${yScale(d.time)}`).join(' ');
        if (!pathData) return null;
        const last = filtered[filtered.length - 1];
        return (
          <g key={driver}>
            <path d={pathData} fill="none" stroke={colour} strokeWidth={isHovered ? 2.5 : 1.2}
              opacity={isOther ? 0.12 : isHovered ? 1 : 0.55}
              style={{ transition: 'opacity 0.15s, stroke-width 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredDriver(driver)} onMouseLeave={() => setHoveredDriver(null)} />
            {!isOther && last && (
              <text x={xScale(last.lap) + 4} y={yScale(last.time) + 3} fill={colour} fontSize={9} fontWeight={isHovered ? 700 : 500} opacity={isHovered ? 1 : 0.65}>{driver}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

registerPanel({ id: 'lap-progression', title: 'Lap Time Progression', category: 'performance', Component: LapProgressionPanel });
export default LapProgressionPanel;
