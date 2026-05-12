/**
 * F1 Pitwall — Strategy Board Panel
 *
 * Tyre stint timeline — horizontal Gantt chart showing each driver's
 * stint sequence with compound colours and lap counts.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { StintData } from '../../lib/api';
import { api } from '../../lib/api';
import { getCompoundColour } from '../../lib/colours';
import { getDriverColour } from '../../lib/colours';
import { formatLapTime } from '../../lib/format';

const StrategyBoardPanel: React.FC<PanelProps> = ({ sessionKey, width }) => {
  const [stints, setStints] = useState<StintData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getStints(sessionKey)
      .then(data => { setStints(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  // Group stints by driver
  const driverStints = useMemo(() => {
    const map = new Map<string, StintData[]>();
    for (const stint of stints) {
      if (!map.has(stint.driver)) map.set(stint.driver, []);
      map.get(stint.driver)!.push(stint);
    }
    return map;
  }, [stints]);

  const maxLap = useMemo(() => {
    return Math.max(...stints.map(s => s.end_lap), 1);
  }, [stints]);

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

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto' }}>
      <svg
        width={chartWidth + 80}
        height={driverStints.size * rowHeight + 30}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
      >
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
