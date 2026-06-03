/**
 * F1 Pitwall — Track Map Panel
 *
 * Circuit map with speed-coloured trace from telemetry data.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, SessionMeta } from '../../lib/api';
import { api } from '../../lib/api';

// @ts-ignore
import circuitsCsv from '../../../data/archive/circuits.csv?raw';

function getRealCircuitName(location: string): string {
  if (!location) return location;
  const lines = circuitsCsv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse CSV row ignoring commas inside quotes
    const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
    if (cols.length > 4) {
      // location is at index 3, name is at index 2
      const rowLocation = cols[3].replace(/(^"|"$)/g, '').trim();
      if (rowLocation.toLowerCase() === location.toLowerCase()) {
        return cols[2].replace(/(^"|"$)/g, '').trim();
      }
    }
  }
  return location;
}

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
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-load fastest lap of the session
  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;

    const autoLoad = async () => {
      setLoading(true);
      setError(null);
      try {
        const [meta, laps] = await Promise.all([
          api.getSession(sessionKey),
          api.getLaps(sessionKey)
        ]);

        if (!isMounted) return;
        setSessionMeta(meta);

        const validLaps = laps.filter(l => l.lap_time != null);
        if (validLaps.length === 0) {
          setError('No lap data available for this session.');
          setLoading(false);
          return;
        }

        // Sort by lap time ascending to find overall fastest
        const fastest = validLaps.sort((a, b) => a.lap_time! - b.lap_time!)[0];
        setDriver(fastest.driver);

        const data = await api.getTelemetry(sessionKey, fastest.driver, 'fastest', 2);
        if (isMounted) {
          setTel(data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (isMounted) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    };

    autoLoad();
    return () => { isMounted = false; };
  }, [sessionKey]);

  const handleLoad = async () => {
    if (!sessionKey || !driver) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTelemetry(sessionKey, driver, 'fastest', 2);
      setTel(data);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  if (!sessionKey) return <div className="state-empty">Select a session to view track map</div>;

  const svgWidth = Math.max(width - 20, 200);
  const svgHeight = Math.max(height - 120, 200);
  const pad = 20;

  const points = tel?.data.filter(d => d.x != null && d.y != null) || [];
  const xs = points.map(d => d.x!);
  const ys = points.map(d => d.y!);
  const speeds = points.map(d => d.speed || 0);
  
  // Calculate bounds
  const minX = points.length > 0 ? Math.min(...xs) : 0;
  const maxX = points.length > 0 ? Math.max(...xs) : 1;
  const minY = points.length > 0 ? Math.min(...ys) : 0;
  const maxY = points.length > 0 ? Math.max(...ys) : 1;
  const minSpeed = points.length > 0 ? Math.min(...speeds) : 0;
  const maxSpeed = points.length > 0 ? Math.max(...speeds) : 350;
  
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Maintain aspect ratio while fitting into available width/height
  const scale = Math.min(
    (svgWidth - pad * 2) / rangeX,
    (svgHeight - pad * 2) / rangeY
  );

  // Center the map in the SVG
  const offsetX = (svgWidth - rangeX * scale) / 2 - minX * scale;
  const offsetY = (svgHeight - rangeY * scale) / 2 - minY * scale;

  const mapX = (x: number) => x * scale + offsetX;
  const mapY = (y: number) => svgHeight - (y * scale + offsetY); // flip Y for screen coordinates

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center', flexShrink: 0 }}>
        <input type="text" placeholder="Driver (e.g. VER or 1)" value={driver}
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

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
        {points.length > 0 && (
          <svg width={svgWidth} height={svgHeight} style={{ display: 'block', margin: '0 auto' }}>
            {/* Track trace coloured by speed */}
            {points.map((p, i) => {
              if (i === 0) return null;
              const prev = points[i - 1];
              return (
                <line key={i}
                  x1={mapX(prev.x!)} y1={mapY(prev.y!)}
                  x2={mapX(p.x!)} y2={mapY(p.y!)}
                  stroke={speedToColour(p.speed || 0, minSpeed, maxSpeed)}
                  strokeWidth={3} strokeLinecap="round"
                />
              );
            })}
            {/* Start/finish marker */}
            {points.length > 0 && (
              <circle cx={mapX(points[0].x!)} cy={mapY(points[0].y!)} r={5} fill="var(--accent-red)" stroke="white" strokeWidth={1} />
            )}
          </svg>
        )}

        {/* Speed legend */}
        {points.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', marginTop: '8px', flexShrink: 0 }}>
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>{Math.round(minSpeed)} km/h</span>
            <div style={{
              width: 120, height: 8, borderRadius: 4,
              background: 'linear-gradient(90deg, rgb(0,100,255), rgb(0,255,155), rgb(255,255,0), rgb(255,55,0))',
            }} />
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>{Math.round(maxSpeed)} km/h</span>
          </div>
        )}

        {sessionMeta && (
          <div style={{ textAlign: 'center', marginTop: '4px', flexShrink: 0 }}>
            <span className="text-secondary mono" style={{ fontSize: 'var(--fs-xs)', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {getRealCircuitName(sessionMeta.circuit_name)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

registerPanel({ id: 'track-map', title: 'Track Map', category: 'telemetry', Component: TrackMapPanel });
export default TrackMapPanel;
