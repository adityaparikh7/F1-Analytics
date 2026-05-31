/**
 * F1 Pitwall — Top Speed Plot Panel
 *
 * Heatmap of top speeds achieved by drivers.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TopSpeedsResponse } from '../../lib/api';
import { api } from '../../lib/api';

function getHeatmapColour(val: number | null, min: number, max: number, bgAlpha = 0.8) {
  if (val === null) return 'transparent';
  const t = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
  // Rocket-like colormap: Dark -> Red -> Orange -> Yellow -> White
  if (t < 0.25) {
    const s = t / 0.25;
    return `rgba(${Math.round(26 + s * 113)}, ${Math.round(26 - s * 26)}, ${Math.round(46 - s * 46)}, ${bgAlpha})`;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return `rgba(${Math.round(139 + s * 116)}, ${Math.round(s * 69)}, 0, ${bgAlpha})`;
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return `rgba(255, ${Math.round(69 + s * 146)}, 0, ${bgAlpha})`;
  } else {
    const s = (t - 0.75) / 0.25;
    return `rgba(255, ${Math.round(215 + s * 40)}, ${Math.round(s * 255)}, ${bgAlpha})`;
  }
}

const TopSpeedPlotPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const [data, setData] = useState<TopSpeedsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topN, setTopN] = useState(10);

  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;
    
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getTopSpeeds(sessionKey, topN);
        if (isMounted) {
          setData(res);
          setLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message);
          setLoading(false);
        }
      }
    };
    
    load();
    return () => { isMounted = false; };
  }, [sessionKey, topN]);

  const { minVal, maxVal } = useMemo(() => {
    if (!data) return { minVal: 0, maxVal: 0 };
    let min = Infinity;
    let max = -Infinity;
    data.data.forEach(d => {
      if (d.average !== null) {
        min = Math.min(min, d.average);
        max = Math.max(max, d.average);
      }
      d.top_speeds.forEach(v => {
        if (v !== null) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      });
    });
    return { minVal: min, maxVal: max };
  }, [data]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view top speeds heatmap</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>Top N:</span>
          <select 
            value={topN} 
            onChange={e => setTopN(Number(e.target.value))}
            style={{ 
              background: 'var(--surface-secondary)', 
              color: 'var(--text-primary)', 
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 6px',
              fontSize: 'var(--fs-xs)'
            }}
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={20}>20</option>
          </select>
        </div>
        
        {data && (
          <span className="text-secondary mono" style={{ fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>
            Source: {data.source === 'speedtrap' ? 'Speed Trap' : 'Telemetry Maxima'}
          </span>
        )}
      </div>

      {error && <div className="state-error" style={{ minHeight: 40, fontSize: 'var(--fs-sm)' }}>{error}</div>}
      {loading && !data && <div className="state-empty" style={{ flex: 1 }}>Loading top speeds...</div>}

      {/* Heatmap Table */}
      {data && (
        <div style={{ flex: 1, overflow: 'auto', paddingRight: '4px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr>
                <th style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)', position: 'sticky', top: 0, background: 'var(--surface-primary)', zIndex: 2 }}>Driver</th>
                {Array.from({ length: topN }).map((_, i) => (
                  <th key={i} style={{ padding: '4px', color: 'var(--text-tertiary)', fontWeight: 'normal', borderBottom: '1px solid var(--border-default)', position: 'sticky', top: 0, background: 'var(--surface-primary)', zIndex: 1 }}>
                    #{i + 1}
                  </th>
                ))}
                <th style={{ padding: '4px 8px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)', borderLeft: '2px solid var(--border-subtle)', position: 'sticky', top: 0, background: 'var(--surface-primary)', zIndex: 1 }}>
                  Avg
                </th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((row, i) => (
                <tr key={i}>
                  <td style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 'bold', borderBottom: '1px solid var(--border-subtle)' }}>
                    {row.driver}
                  </td>
                  {row.top_speeds.map((val, j) => (
                    <td 
                      key={j} 
                      style={{ 
                        padding: '4px', 
                        borderBottom: '1px solid var(--border-subtle)',
                        background: getHeatmapColour(val, minVal, maxVal, 0.7),
                        color: val ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      }}
                    >
                      {val ? val.toFixed(1) : '-'}
                    </td>
                  ))}
                  <td 
                    style={{ 
                      padding: '4px 8px', 
                      borderBottom: '1px solid var(--border-subtle)',
                      borderLeft: '2px solid var(--border-subtle)',
                      background: getHeatmapColour(row.average, minVal, maxVal, 0.9),
                      fontWeight: 'bold',
                      color: row.average ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    {row.average ? row.average.toFixed(1) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

registerPanel({
  id: 'top-speed-plot',
  title: 'Top Speed Plot',
  category: 'performance',
  Component: TopSpeedPlotPanel,
});

export default TopSpeedPlotPanel;
