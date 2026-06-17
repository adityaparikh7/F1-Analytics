/**
 * F1 Pitwall — Strategy Board Panel
 *
 * Tyre stint timeline — horizontal Gantt chart showing each driver's
 * stint sequence with compound colours and lap counts.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { StintData, ResultData, LapData } from '../../lib/api';
import { api } from '../../lib/api';
import { getCompoundColour } from '../../lib/colours';
import { getDriverColour } from '../../lib/colours';

const StrategyBoardPanel: React.FC<PanelProps> = ({ sessionKey, width }) => {
  const [stints, setStints] = useState<StintData[]>([]);
  const [results, setResults] = useState<ResultData[]>([]);
  const [laps, setLaps] = useState<LapData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);
    
    Promise.all([
      api.getStints(sessionKey),
      api.getResults(sessionKey).catch(() => [] as ResultData[]), // Fallback if results fail
      api.getLaps(sessionKey).catch(() => [] as LapData[]) // Fallback if laps fail
    ])
      .then(([stintData, resultData, lapData]) => {
        if (!isMounted) return;
        setStints(stintData);
        setResults(resultData);
        setLaps(lapData);
        setLoading(false);
      })
      .catch(err => {
        if (!isMounted) return;
        setError(err.message);
        setLoading(false);
      });
      
    return () => { isMounted = false; };
  }, [sessionKey]);

  // Group stints by driver and sort by finishing position
  const driverStints = useMemo(() => {
    const map = new Map<string, StintData[]>();
    for (const stint of stints) {
      if (!map.has(stint.driver)) map.set(stint.driver, []);
      map.get(stint.driver)!.push(stint);
    }
    
    // Create an array of entries to sort
    const entries = Array.from(map.entries());
    
    // Create a lookup for positions
    const posMap = new Map<string, number>();
    results.forEach(r => {
      if (r.position != null) posMap.set(r.driver, r.position);
    });
    
    // Sort: drivers with known positions first, then alphabetically
    entries.sort((a, b) => {
      const posA = posMap.get(a[0]) ?? 999;
      const posB = posMap.get(b[0]) ?? 999;
      if (posA !== posB) return posA - posB;
      return a[0].localeCompare(b[0]);
    });
    
    return new Map(entries);
  }, [stints, results]);

  const maxLap = useMemo(() => {
    return Math.max(...stints.map(s => s.end_lap), 1);
  }, [stints]);

  const { scLaps, vscLaps } = useMemo(() => {
    const sc = new Set<number>();
    const vsc = new Set<number>();
    
    for (const lap of laps) {
      if (!lap.track_status) continue;
      if (lap.track_status.includes('4')) {
        sc.add(lap.lap_number);
      }
      if (lap.track_status.includes('6')) {
        vsc.add(lap.lap_number);
      }
    }
    return { scLaps: Array.from(sc), vscLaps: Array.from(vsc) };
  }, [laps]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view strategy</div>;
  }

  if (loading) {
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

  if (driverStints.size === 0) {
    return <div className="state-empty">No stint data available</div>;
  }

  const chartWidth = Math.max(width - 80, 200);
  const barHeight = 20;
  const rowHeight = 28;

  const hasSC = scLaps.length > 0;
  const hasVSC = vscLaps.length > 0;
  const bottomPadding = hasSC || hasVSC ? 50 : 30;

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto' }}>
      <svg
        width={chartWidth + 80}
        height={driverStints.size * rowHeight + bottomPadding}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
      >
        {/* Safety Car Backgrounds */}
        {scLaps.map(lap => (
          <rect
            key={`sc-${lap}`}
            x={70 + ((lap - 1) / maxLap) * chartWidth}
            y={0}
            width={chartWidth / maxLap}
            height={driverStints.size * rowHeight}
            fill="#f59e0b"
            opacity={0.5}
          />
        ))}

        {/* VSC Backgrounds */}
        {vscLaps.map(lap => (
          <rect
            key={`vsc-${lap}`}
            x={70 + ((lap - 1) / maxLap) * chartWidth}
            y={0}
            width={chartWidth / maxLap}
            height={driverStints.size * rowHeight}
            fill="#eab308"
            opacity={0.5}
          />
        ))}

        {/* Lap axis markers */}
        {Array.from({ length: Math.ceil(maxLap / 10) + 1 }, (_, i) => i * 10).map(lap => (
          <g key={`axis-${lap}`}>
            <line
              x1={70 + (lap / maxLap) * chartWidth}
              y1={0}
              x2={70 + (lap / maxLap) * chartWidth}
              y2={driverStints.size * rowHeight}
              stroke="var(--border-default)"
              strokeDasharray="2,4"
            />
            <text
              x={70 + (lap / maxLap) * chartWidth}
              y={driverStints.size * rowHeight + 16}
              fill="var(--text-tertiary)"
              textAnchor="middle"
              fontSize={10}
            >
              {lap}
            </text>
          </g>
        ))}

        {/* Stint bars per driver */}
        {Array.from(driverStints.entries()).map(([driver, driverStintList], driverIdx) => (
          <g key={driver}>
            {/* Driver label */}
            <text
              x={60}
              y={driverIdx * rowHeight + barHeight / 2 + 4}
              fill={getDriverColour(driver, driverStintList[0]?.team)}
              textAnchor="end"
              fontWeight={600}
              fontSize={11}
            >
              {driver}
            </text>

            {/* Stint bars */}
            {driverStintList.map((stint, stintIdx) => {
              const x = 70 + ((stint.start_lap - 1) / maxLap) * chartWidth;
              const w = Math.max((stint.lap_count / maxLap) * chartWidth, 2);
              const colour = getCompoundColour(stint.compound);

              return (
                <g key={`${driver}-${stintIdx}`}>
                  <rect
                    x={x}
                    y={driverIdx * rowHeight + 2}
                    width={w}
                    height={barHeight}
                    rx={3}
                    fill={colour}
                    opacity={0.85}
                  />
                  {w > 30 && (
                    <text
                      x={x + w / 2}
                      y={driverIdx * rowHeight + barHeight / 2 + 5}
                      fill={stint.compound === 'HARD' || stint.compound === 'MEDIUM' || stint.compound === 'INTERMEDIATE' ? '#0A0A0C' : '#F0F0F0'}
                      textAnchor="middle"
                      fontSize={9}
                      fontWeight={600}
                    >
                      {stint.lap_count}L
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}

        {/* Legend */}
        {(hasSC || hasVSC) && (
          <g transform={`translate(70, ${driverStints.size * rowHeight + 35})`}>
            {hasSC && (
              <g>
                <rect width={12} height={12} fill="#f59e0b" opacity={0.3} rx={2} y={-10} />
                <text x={18} y={0} fill="var(--text-secondary)" fontSize={10}>Safety Car</text>
              </g>
            )}
            {hasVSC && (
              <g transform={hasSC ? "translate(90, 0)" : ""}>
                <rect width={12} height={12} fill="#eab308" opacity={0.3} rx={2} y={-10} />
                <text x={18} y={0} fill="var(--text-secondary)" fontSize={10}>Virtual SC</text>
              </g>
            )}
          </g>
        )}
      </svg>
    </div>
  );
};

registerPanel({
  id: 'strategy-board',
  title: 'Strategy Board',
  category: 'strategy',
  Component: StrategyBoardPanel,
});

export default StrategyBoardPanel;
