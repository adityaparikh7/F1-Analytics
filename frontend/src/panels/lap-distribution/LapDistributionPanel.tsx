/**
 * F1 Pitwall — Lap Time Distribution Panel
 *
 * Box-plot style distribution of lap times by driver.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { LapData, ResultData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';
import { formatLapTime } from '../../lib/format';

const LapDistributionPanel: React.FC<PanelProps> = ({ sessionKey, width }) => {
  const [laps, setLaps] = useState<LapData[]>([]);
  const [results, setResults] = useState<ResultData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lapFilter, setLapFilter] = useState<'timed' | 'all'>('timed');
  const [onlyFinishers, setOnlyFinishers] = useState(false);

  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);
    
    Promise.all([
      api.getLaps(sessionKey, { exclude_pit_laps: false }),
      api.getResults(sessionKey).catch(() => [] as ResultData[])
    ])
      .then(([lapData, resultData]) => {
        if (!isMounted) return;
        setLaps(lapData);
        setResults(resultData);
        setLoading(false);
      })
      .catch(err => {
        if (!isMounted) return;
        setError(err.message);
        setLoading(false);
      });
      
    return () => { isMounted = false; };
  }, [sessionKey]);

  // Compute per-driver statistics
  const driverStats = useMemo(() => {
    const map = new Map<string, { times: number[]; team: string | null }>();
    
    const finishingDrivers = new Set<string>();
    if (onlyFinishers) {
      for (const r of results) {
        if (r.status === 'Finished' || r.status === 'Lapped' || r.status?.includes('+')) {
          finishingDrivers.add(r.driver);
        }
      }
    }

    for (const lap of laps) {
      if (lap.lap_time == null || lap.lap_time <= 0) continue;
      
      if (lapFilter === 'timed') {
        if (lap.is_pit_in_lap || lap.is_pit_out_lap) continue;
        // You could also add track_status !== '1' here if desired
      }
      
      if (onlyFinishers && !finishingDrivers.has(lap.driver)) {
        continue;
      }
      
      if (!map.has(lap.driver)) map.set(lap.driver, { times: [], team: lap.team });
      map.get(lap.driver)!.times.push(lap.lap_time);
    }

    return Array.from(map.entries())
      .map(([driver, { times, team }]) => {
        const sorted = [...times].sort((a, b) => a - b);
        const len = sorted.length;
        if (len === 0) return null;
        return {
          driver,
          team,
          min: sorted[0],
          q1: sorted[Math.floor(len * 0.25)],
          median: sorted[Math.floor(len * 0.5)],
          q3: sorted[Math.floor(len * 0.75)],
          max: sorted[len - 1],
          count: len,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.median - b!.median) as Array<{
        driver: string;
        team: string | null;
        min: number;
        q1: number;
        median: number;
        q3: number;
        max: number;
        count: number;
      }>;
  }, [laps, results, lapFilter, onlyFinishers]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view lap distributions</div>;
  }

  if (loading && laps.length === 0) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return <div className="state-error">{error}</div>;
  }

  // SVG box plot
  const chartWidth = Math.max(width - 80, 200);
  const rowH = 22;
  const chartHeight = driverStats.length * rowH + 30;
  
  let globalMin = 0, globalMax = 0, range = 1;
  if (driverStats.length > 0) {
    globalMin = Math.min(...driverStats.map(d => d.min));
    globalMax = Math.max(...driverStats.map(d => d.max));
    range = globalMax - globalMin || 1;
  }
  const xScale = (val: number) => 70 + ((val - globalMin) / range) * (chartWidth - 20);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '0 0 var(--space-2) 0', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={onlyFinishers} 
            onChange={e => setOnlyFinishers(e.target.checked)} 
          />
          Only Finishers
        </label>
        <select 
          value={lapFilter} 
          onChange={e => setLapFilter(e.target.value as 'timed' | 'all')}
          style={{ fontSize: 'var(--fs-xs)', padding: '4px 8px' }}
        >
          <option value="timed">Proper Timed Laps</option>
          <option value="all">All Laps</option>
        </select>
      </div>
      
      {driverStats.length === 0 ? (
        <div className="state-empty">No lap time data available for this filter</div>
      ) : (
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
          <svg
            width={chartWidth + 80}
            height={chartHeight}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            {driverStats.map((d, i) => {
              const y = i * rowH + 4;
              const colour = getDriverColour(d.driver, d.team);
              const boxH = 14;

              return (
                <g key={d.driver}>
                  {/* Driver label */}
                  <text x={60} y={y + boxH / 2 + 4} fill={colour} textAnchor="end" fontWeight={600} fontSize={11}>
                    {d.driver}
                  </text>

                  {/* Whisker line (min to max) */}
                  <line x1={xScale(d.min)} y1={y + boxH / 2} x2={xScale(d.max)} y2={y + boxH / 2} stroke={colour} strokeWidth={1} opacity={0.5} />

                  {/* Box (Q1 to Q3) */}
                  <rect
                    x={xScale(d.q1)}
                    y={y}
                    width={Math.max(xScale(d.q3) - xScale(d.q1), 1)}
                    height={boxH}
                    rx={2}
                    fill={colour}
                    opacity={0.3}
                    stroke={colour}
                    strokeWidth={1}
                  />

                  {/* Median line */}
                  <line x1={xScale(d.median)} y1={y} x2={xScale(d.median)} y2={y + boxH} stroke={colour} strokeWidth={2} />

                  {/* Min/Max caps */}
                  <line x1={xScale(d.min)} y1={y + 3} x2={xScale(d.min)} y2={y + boxH - 3} stroke={colour} strokeWidth={1} opacity={0.5} />
                  <line x1={xScale(d.max)} y1={y + 3} x2={xScale(d.max)} y2={y + boxH - 3} stroke={colour} strokeWidth={1} opacity={0.5} />
                </g>
              );
            })}

            {/* Time axis */}
            {Array.from({ length: 6 }, (_, i) => globalMin + (range * i) / 5).map((val, i) => (
              <text
                key={i}
                x={xScale(val)}
                y={driverStats.length * rowH + 20}
                fill="var(--text-tertiary)"
                textAnchor="middle"
                fontSize={9}
              >
                {formatLapTime(val)}
              </text>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
};

registerPanel({
  id: 'lap-distribution',
  title: 'Lap Time Distribution',
  category: 'performance',
  Component: LapDistributionPanel,
});

export default LapDistributionPanel;
