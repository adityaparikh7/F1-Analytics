/**
 * F1 Pitwall — Track Map Panel
 *
 * Circuit map with speed-coloured trace from telemetry data.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, SessionMeta, CornerData } from '../../lib/api';
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
  const [corners, setCorners] = useState<CornerData[]>([]);
  const [showCorners, setShowCorners] = useState(true);
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
        const [meta, laps, cornersData] = await Promise.all([
          api.getSession(sessionKey),
          api.getLaps(sessionKey),
          api.getCircuitInfo(sessionKey).catch(err => {
            console.error('Failed to load circuit corners:', err);
            return [] as CornerData[];
          })
        ]);

        if (!isMounted) return;
        setSessionMeta(meta);
        setCorners(cornersData);

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
  const pad = 30;

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

        <label style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          marginLeft: 'auto', cursor: 'pointer', userSelect: 'none',
          fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)',
        }}>
          <input
            type="checkbox"
            checked={showCorners}
            onChange={e => setShowCorners(e.target.checked)}
            style={{ accentColor: 'var(--accent-teal)' }}
          />
          Corners
        </label>
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

            {/* Corner Markers */}
            {showCorners && corners.map((corner, idx) => {
              // Get raw coordinate
              let cx_raw = corner.x;
              let cy_raw = corner.y;

              // Fallback: match by distance
              if (cx_raw == null || cy_raw == null) {
                if (points.length === 0 || corner.distance == null) return null;
                let closest = points[0];
                let minDiff = Math.abs((closest.distance || 0) - corner.distance);
                for (let i = 1; i < points.length; i++) {
                  const p = points[i];
                  const diff = Math.abs((p.distance || 0) - corner.distance);
                  if (diff < minDiff) {
                    minDiff = diff;
                    closest = p;
                  }
                }
                if (closest.x == null || closest.y == null) return null;
                cx_raw = closest.x;
                cy_raw = closest.y;
              }

              const cx = mapX(cx_raw);
              const cy = mapY(cy_raw);

              const angleDeg = corner.angle ?? 0;
              const angleRad = (angleDeg * Math.PI) / 180;
              const labelOffset = 22; // pixels offset from track
              
              const labelX = cx + labelOffset * Math.cos(angleRad);
              const labelY = cy - labelOffset * Math.sin(angleRad);

              const text = `${corner.number}${corner.letter || ''}`;
              const isLong = text.length > 2;
              const r = isLong ? 10.5 : 8.5;

              return (
                <g key={`corner-${idx}`}>
                  {/* Connector Line */}
                  <line 
                    x1={cx} 
                    y1={cy} 
                    x2={labelX} 
                    y2={labelY} 
                    stroke="rgba(255, 255, 255, 0.35)" 
                    strokeWidth={1} 
                    strokeDasharray="2,2" 
                  />
                  {/* Track point dot */}
                  <circle cx={cx} cy={cy} r={2} fill="white" opacity={0.8} />
                  {/* Corner Bubble */}
                  <circle 
                    cx={labelX} 
                    cy={labelY} 
                    r={r} 
                    fill="var(--surface-primary, #1e1e24)" 
                    stroke="rgba(255, 255, 255, 0.45)" 
                    strokeWidth={1} 
                  />
                  {/* Corner Text */}
                  <text 
                    x={labelX} 
                    y={labelY} 
                    textAnchor="middle" 
                    dominantBaseline="central" 
                    fill="var(--text-primary, #ffffff)" 
                    fontSize="9px" 
                    fontWeight="bold"
                    style={{ userSelect: 'none' }}
                  >
                    {text}
                  </text>
                </g>
              );
            })}
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
