/**
 * F1 Pitwall — Position Changes Panel
 *
 * Plot the position of each driver at the end of each lap.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { LapData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';

const PositionChangesPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [laps, setLaps] = useState<LapData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDriver, setHoveredDriver] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getLaps(sessionKey, { exclude_pit_laps: false })
      .then(data => { setLaps(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  const { driverLaps, drivers, maxLap, maxPos } = useMemo(() => {
    const map = new Map<string, { laps: Array<{ lap: number; position: number }>; team: string | null }>();
    let maxPosition = 20;

    for (const lap of laps) {
      if (lap.position == null || lap.position <= 0) continue;
      if (!map.has(lap.driver)) map.set(lap.driver, { laps: [], team: lap.team });
      map.get(lap.driver)!.laps.push({ lap: lap.lap_number, position: lap.position });
      if (lap.position > maxPosition) maxPosition = lap.position;
    }
    
    // Position changes usually are 1 to 20, but can be 1 to 22. Get exact drivers map.
    return {
      driverLaps: map,
      drivers: Array.from(map.keys()),
      maxLap: Math.max(...laps.map(l => l.lap_number), 1),
      maxPos: maxPosition,
    };
  }, [laps]);

  if (!sessionKey) return <div className="state-empty">Select a session to view position changes</div>;
  if (loading) return <div className="state-loading"><div className="skeleton skeleton--bar" /><div className="skeleton skeleton--bar" /></div>;
  if (error) return <div className="state-error">{error}</div>;
  if (drivers.length === 0) return <div className="state-empty">No lap data available</div>;

  const chartW = Math.max(width - 20, 300);
  const chartH = Math.max(height - 20, 200);
  const padL = 30, padT = 15, padR = 40, padB = 25;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  
  const minPos = 1;
  const posRange = maxPos - minPos || 1;
  
  const xScale = (lap: number) => padL + ((lap - 1) / (maxLap - 1 || 1)) * plotW;
  // y=0 is padT, y=plotH is padT+plotH
  // position 1 is at top (padT). position maxPos is at bottom (padT + plotH)
  const yScale = (pos: number) => padT + ((pos - minPos) / posRange) * plotH;

  const yTicks = [1, 5, 10, 15, 20].filter(tick => tick <= maxPos);
  if (!yTicks.includes(maxPos) && maxPos > 20) yTicks.push(maxPos);

  const xTicks = Array.from({ length: Math.min(Math.ceil(maxLap / 10), 8) + 1 }, (_, i) => Math.max(i * 10, 1));
  if (!xTicks.includes(maxLap)) xTicks.push(maxLap);

  return (
    <svg width={chartW} height={chartH} style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
      {/* Gridlines */}
      {yTicks.map(pos => (
        <g key={pos}>
          <line x1={padL} y1={yScale(pos)} x2={padL + plotW} y2={yScale(pos)} stroke="var(--border-default)" strokeDasharray="2,4" />
          <text x={padL - 4} y={yScale(pos) + 3} fill="var(--text-tertiary)" textAnchor="end" fontSize={9}>P{pos}</text>
        </g>
      ))}
      
      {/* Lap axis */}
      {xTicks.map(lap => (
        <text key={lap} x={xScale(lap)} y={chartH - 4} fill="var(--text-tertiary)" textAnchor="middle" fontSize={9}>L{lap}</text>
      ))}
      
      {/* Driver lines */}
      {drivers.map(driver => {
        const data = driverLaps.get(driver)!;
        const colour = getDriverColour(driver, data.team);
        const isHovered = hoveredDriver === driver;
        const isOther = hoveredDriver != null && !isHovered;
        
        // Sort by lap
        const filtered = data.laps.sort((a, b) => a.lap - b.lap);
        const pathData = filtered.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.lap)} ${yScale(d.position)}`).join(' ');
        
        if (!pathData) return null;
        const last = filtered[filtered.length - 1];
        
        return (
          <g key={driver}>
            <path d={pathData} fill="none" stroke={colour} strokeWidth={isHovered ? 3 : 1.5}
              opacity={isOther ? 0.1 : isHovered ? 1 : 0.8}
              style={{ transition: 'opacity 0.15s, stroke-width 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredDriver(driver)} onMouseLeave={() => setHoveredDriver(null)} />
            
            {/* Draw dots on hover to enhance visibility of lap points */}
            {isHovered && filtered.map(d => (
                <circle key={d.lap} cx={xScale(d.lap)} cy={yScale(d.position)} r={2.5} fill={colour} />
            ))}

            {!isOther && last && (
              <text x={xScale(last.lap) + 4} y={yScale(last.position) + 3} fill={colour} fontSize={9} fontWeight={isHovered ? 700 : 500} opacity={isHovered ? 1 : 0.8}>{driver}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

registerPanel({ id: 'position-changes', title: 'Position Changes', category: 'performance', Component: PositionChangesPanel });
export default PositionChangesPanel;
