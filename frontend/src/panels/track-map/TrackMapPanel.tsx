/**
 * F1 Pitwall — Track Map Panel
 *
 * Circuit map with speed-coloured trace from telemetry data.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';

function speedToColour(speed: number, minSpeed: number, maxSpeed: number): string {
  const ratio = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed || 1)));
  // Blue (slow) → Green → Yellow → Red (fast)
  if (ratio < 0.33) {
    const t = ratio / 0.33;
    return `rgb(${Math.round(0 + t * 0)}, ${Math.round(100 + t * 155)}, ${Math.round(255 - t * 100)})`;
  } else if (ratio < 0.66) {
    const t = (ratio - 0.33) / 0.33;
    return `rgb(${Math.round(t * 255)}, ${Math.round(255)}, ${Math.round(155 - t * 155)})`;
  } else {
    const t = (ratio - 0.66) / 0.34;
    return `rgb(255, ${Math.round(255 - t * 200)}, 0)`;
  }
}

const TrackMapPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [driver, setDriver] = useState('');
  const [tel, setTel] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = async () => {
    if (!sessionKey || !driver) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTelemetry(sessionKey, driver, 'fastest', 2);
      setTel(data);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  };

  if (!sessionKey) return <div className="state-empty">Select a session to view track map</div>;

  const chartSize = Math.min(Math.max(width - 20, 200), Math.max(height - 70, 200));
  const pad = 20;

  const points = tel?.data.filter(d => d.x != null && d.y != null) || [];
  const xs = points.map(d => d.x!);
  const ys = points.map(d => d.y!);
  const speeds = points.map(d => d.speed || 0);
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 1);
  const minSpeed = Math.min(...speeds, 0), maxSpeed = Math.max(...speeds, 350);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scale = (chartSize - pad * 2) / Math.max(rangeX, rangeY);

  const mapX = (x: number) => pad + (x - minX) * scale;
  const mapY = (y: number) => pad + (rangeY - (y - minY)) * scale; // flip Y

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
        <input type="text" placeholder="Driver (e.g. VER)" value={driver}
          onChange={e => setDriver(e.target.value.toUpperCase())}
          style={{ width: 100, textTransform: 'uppercase' }} />
        <button className="topbar__btn topbar__btn--primary" onClick={handleLoad}
          disabled={loading || !driver} style={{ fontSize: 'var(--fs-xs)', padding: '3px 12px' }}>
          {loading ? '...' : 'Load'}
        </button>
        {tel && <span className="text-secondary mono" style={{ fontSize: 'var(--fs-xs)' }}>{tel.driver} — {tel.sample_count} pts</span>}
      </div>

      {error && <div className="state-error" style={{ minHeight: 40, fontSize: 'var(--fs-sm)' }}>{error}</div>}
      {!tel && !loading && <div className="state-empty" style={{ minHeight: 100 }}>Enter a driver code and click Load</div>}

      {points.length > 0 && (
        <svg width={chartSize} height={chartSize} style={{ display: 'block', margin: '0 auto' }}>
          {/* Track trace coloured by speed */}
          {points.map((p, i) => {
            if (i === 0) return null;
            const prev = points[i - 1];
            return (
              <line key={i}
                x1={mapX(prev.x!)} y1={mapY(prev.y!)}
                x2={mapX(p.x!)} y2={mapY(p.y!)}
                stroke={speedToColour(p.speed || 0, minSpeed, maxSpeed)}
                strokeWidth={2.5} strokeLinecap="round"
              />
            );
          })}
          {/* Start/finish marker */}
          {points.length > 0 && (
            <circle cx={mapX(points[0].x!)} cy={mapY(points[0].y!)} r={4} fill="var(--accent-red)" />
          )}
        </svg>
      )}

      {/* Speed legend */}
      {points.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
          <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>{Math.round(minSpeed)} km/h</span>
          <div style={{
            width: 120, height: 8, borderRadius: 4,
            background: 'linear-gradient(90deg, rgb(0,100,255), rgb(0,255,155), rgb(255,255,0), rgb(255,55,0))',
          }} />
          <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>{Math.round(maxSpeed)} km/h</span>
        </div>
      )}
    </div>
  );
};

registerPanel({ id: 'track-map', title: 'Track Map', category: 'telemetry', Component: TrackMapPanel });
export default TrackMapPanel;
