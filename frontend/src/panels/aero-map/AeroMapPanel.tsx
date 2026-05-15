/**
 * F1 Pitwall — Aero Map Panel
 *
 * Visualises aerodynamic characteristics across the circuit by computing
 * derived metrics from telemetry:
 *
 *  • Aero Efficiency  — speed / throttle ratio (higher = less drag)
 *  • Cornering Load   — lateral-g proxy via speed in corners (higher = more downforce)
 *  • Drag Index       — throttle required per unit speed (inverse efficiency)
 *
 * Supports loading two drivers simultaneously for side-by-side comparison
 * on the same circuit layout.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, TelemetryPoint } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';

// ── Aero channel definitions ────────────────────────────────────────

type AeroChannel = 'efficiency' | 'cornering' | 'drag';

const CHANNEL_META: Record<AeroChannel, { label: string; unit: string; gradient: string; desc: string }> = {
  efficiency: {
    label: 'Aero Efficiency',
    unit: 'spd/thr',
    gradient: 'linear-gradient(90deg, #E8002D, #FF8000, #FFC906, #00D2BE, #0064FF)',
    desc: 'Speed per throttle % — higher means less drag',
  },
  cornering: {
    label: 'Cornering Load',
    unit: 'km/h',
    gradient: 'linear-gradient(90deg, #1a1a2e, #6C3483, #E8002D, #FFC906)',
    desc: 'Corner speed — proxy for downforce grip',
  },
  drag: {
    label: 'Drag Index',
    unit: 'thr/spd',
    gradient: 'linear-gradient(90deg, #00D2BE, #27F4D2, #FFC906, #FF8000, #E8002D)',
    desc: 'Throttle per unit speed — higher means more drag',
  },
};

// ── Colour mapping ──────────────────────────────────────────────────

function channelColour(t: number, channel: AeroChannel): string {
  t = Math.max(0, Math.min(1, t));

  if (channel === 'efficiency') {
    // Red → Orange → Yellow → Teal → Blue (low→high efficiency)
    if (t < 0.25) {
      const s = t / 0.25;
      return `rgb(${232 + Math.round(s * 23)}, ${Math.round(s * 128)}, ${Math.round(45 * s)})`;
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      return `rgb(${255 - Math.round(s * 4)}, ${128 + Math.round(s * 73)}, ${Math.round(6 + s * 0)})`;
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      return `rgb(${255 - Math.round(s * 255)}, ${201 + Math.round(s * 9)}, ${6 + Math.round(s * 184)})`;
    } else {
      const s = (t - 0.75) / 0.25;
      return `rgb(${Math.round(s * 0)}, ${210 - Math.round(s * 20)}, ${190 + Math.round(s * 65)})`;
    }
  } else if (channel === 'cornering') {
    // Dark → Purple → Red → Amber
    if (t < 0.33) {
      const s = t / 0.33;
      return `rgb(${26 + Math.round(s * 82)}, ${26 + Math.round(s * 26)}, ${46 + Math.round(s * 85)})`;
    } else if (t < 0.66) {
      const s = (t - 0.33) / 0.33;
      return `rgb(${108 + Math.round(s * 124)}, ${52 - Math.round(s * 52)}, ${131 - Math.round(s * 86)})`;
    } else {
      const s = (t - 0.66) / 0.34;
      return `rgb(${232 + Math.round(s * 23)}, ${Math.round(s * 201)}, ${45 * s})`;
    }
  } else {
    // Teal → Cyan → Yellow → Orange → Red (low→high drag)
    if (t < 0.25) {
      const s = t / 0.25;
      return `rgb(${Math.round(s * 39)}, ${210 + Math.round(s * 34)}, ${190 + Math.round(s * 20)})`;
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      return `rgb(${39 + Math.round(s * 216)}, ${244 - Math.round(s * 43)}, ${210 - Math.round(s * 204)})`;
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      return `rgb(${255}, ${201 - Math.round(s * 73)}, ${6 - Math.round(s * 6)})`;
    } else {
      const s = (t - 0.75) / 0.25;
      return `rgb(${255 - Math.round(s * 23)}, ${128 - Math.round(s * 128)}, 0)`;
    }
  }
}

// ── Compute aero metrics from telemetry ─────────────────────────────

interface AeroPoint {
  x: number;
  y: number;
  value: number;
  speed: number;
  throttle: number;
  distance: number;
}

function computeAeroMetrics(data: TelemetryPoint[], channel: AeroChannel): AeroPoint[] {
  const pts: AeroPoint[] = [];

  for (const d of data) {
    if (d.x == null || d.y == null || d.speed == null || d.throttle == null || d.distance == null) continue;
    const speed = d.speed;
    const throttle = Math.max(d.throttle, 1); // avoid division by zero

    let value: number;
    switch (channel) {
      case 'efficiency':
        value = speed / throttle; // higher = more efficient
        break;
      case 'cornering':
        // Use raw speed — in corners (low throttle zones) this reveals downforce
        value = speed;
        break;
      case 'drag':
        value = throttle / Math.max(speed, 1); // higher = more drag
        break;
    }

    pts.push({ x: d.x, y: d.y, value, speed, throttle, distance: d.distance });
  }

  return pts;
}

// ── Driver trace container ──────────────────────────────────────────

interface DriverAero {
  driver: string;
  sampleCount: number;
  pts: AeroPoint[];
  minVal: number;
  maxVal: number;
  colour: string;
}

// ── Component ───────────────────────────────────────────────────────

const AeroMapPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [driver1Input, setDriver1Input] = useState('');
  const [driver2Input, setDriver2Input] = useState('');
  const [telData, setTelData] = useState<TelemetryResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<AeroChannel>('efficiency');
  const [dotSize, setDotSize] = useState(2.5);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // which driver map is hovered

  const handleLoad = useCallback(async () => {
    if (!sessionKey || !driver1Input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const drivers = [driver1Input.trim()];
      if (driver2Input.trim()) drivers.push(driver2Input.trim());

      const results: TelemetryResponse[] = [];
      for (const drv of drivers) {
        const data = await api.getTelemetry(sessionKey, drv, 'fastest', 1);
        results.push(data);
      }
      setTelData(results);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [sessionKey, driver1Input, driver2Input]);

  // Compute aero data for each driver
  const driverAero: DriverAero[] = useMemo(() => {
    return telData.map(tel => {
      const pts = computeAeroMetrics(tel.data, channel);
      const values = pts.map(p => p.value);
      const minVal = values.length > 0 ? Math.min(...values) : 0;
      const maxVal = values.length > 0 ? Math.max(...values) : 1;
      return {
        driver: tel.driver,
        sampleCount: tel.sample_count,
        pts,
        minVal,
        maxVal,
        colour: getDriverColour(tel.driver),
      };
    });
  }, [telData, channel]);

  // Global value bounds for consistent colouring across drivers
  const globalBounds = useMemo(() => {
    if (driverAero.length === 0) return { min: 0, max: 1 };
    const min = Math.min(...driverAero.map(d => d.minVal));
    const max = Math.max(...driverAero.map(d => d.maxVal));
    return { min, max };
  }, [driverAero]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view the aero map</div>;
  }

  const isSingle = driverAero.length <= 1;
  const mapSize = isSingle
    ? Math.min(Math.max(width - 20, 200), Math.max(height - 120, 200))
    : Math.min(Math.max((width - 30) / 2, 160), Math.max(height - 120, 160));
  const pad = 12;

  // Render a single circuit map
  const renderMap = (da: DriverAero, idx: number) => {
    if (da.pts.length === 0) return null;

    const xs = da.pts.map(p => p.x);
    const ys = da.pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = (mapSize - pad * 2) / Math.max(rangeX, rangeY);
    const offsetX = (mapSize - rangeX * scale) / 2 - minX * scale;
    const offsetY = (mapSize - rangeY * scale) / 2 - minY * scale;
    const mx = (x: number) => x * scale + offsetX;
    const my = (y: number) => mapSize - (y * scale + offsetY);

    const isHovered = hoverIdx === idx;

    return (
      <div
        key={da.driver}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}
        onMouseEnter={() => setHoverIdx(idx)}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Driver label */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: da.colour, display: 'inline-block',
          }} />
          <span style={{ color: da.colour }}>{da.driver}</span>
          <span className="text-tertiary" style={{ fontWeight: 400 }}>{da.sampleCount} pts</span>
        </div>

        <svg
          width={mapSize}
          height={mapSize}
          style={{
            display: 'block',
            borderRadius: 'var(--radius-md)',
            border: `1px solid ${isHovered ? 'var(--border-emphasis)' : 'var(--border-default)'}`,
            background: 'var(--bg-elevated)',
            transition: 'border-color 0.2s',
          }}
        >
          {/* Dark track outline */}
          <polyline
            points={da.pts.map(p => `${mx(p.x)},${my(p.y)}`).join(' ')}
            fill="none"
            stroke="var(--border-default)"
            strokeWidth={dotSize + 5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.5}
          />

          {/* Coloured dots by aero metric */}
          {da.pts.map((p, i) => {
            const t = (p.value - globalBounds.min) / (globalBounds.max - globalBounds.min || 1);
            const colour = channelColour(t, channel);
            return (
              <circle
                key={i}
                cx={mx(p.x)}
                cy={my(p.y)}
                r={dotSize}
                fill={colour}
                opacity={0.9}
              />
            );
          })}

          {/* Start/finish marker */}
          {da.pts.length > 0 && (
            <circle
              cx={mx(da.pts[0].x)}
              cy={my(da.pts[0].y)}
              r={5}
              fill="none"
              stroke="var(--accent-red)"
              strokeWidth={2}
            />
          )}

          {/* Min/Max zone annotations */}
          {da.pts.length > 0 && (() => {
            const maxPt = da.pts.reduce((best, p) => p.value > best.value ? p : best);
            const minPt = da.pts.reduce((worst, p) => p.value < worst.value ? p : worst);
            return (
              <>
                <g>
                  <circle cx={mx(maxPt.x)} cy={my(maxPt.y)} r={4} fill="none" stroke="#00D2BE" strokeWidth={1.5} />
                  <text x={mx(maxPt.x) + 7} y={my(maxPt.y) - 5} fill="#00D2BE" fontSize={8} fontFamily="var(--font-mono)" fontWeight={600}>
                    ▲ {maxPt.value.toFixed(1)}
                  </text>
                </g>
                <g>
                  <circle cx={mx(minPt.x)} cy={my(minPt.y)} r={4} fill="none" stroke="#E8002D" strokeWidth={1.5} />
                  <text x={mx(minPt.x) + 7} y={my(minPt.y) + 12} fill="#E8002D" fontSize={8} fontFamily="var(--font-mono)" fontWeight={600}>
                    ▼ {minPt.value.toFixed(1)}
                  </text>
                </g>
              </>
            );
          })()}
        </svg>

        {/* Per-driver stats */}
        <div style={{
          display: 'flex', gap: '10px', fontSize: 9, fontFamily: 'var(--font-mono)',
          color: 'var(--text-tertiary)',
        }}>
          <span>MIN <span style={{ color: 'var(--text-secondary)' }}>{da.minVal.toFixed(2)}</span></span>
          <span>AVG <span style={{ color: 'var(--text-secondary)' }}>{(da.pts.reduce((s, p) => s + p.value, 0) / da.pts.length).toFixed(2)}</span></span>
          <span>MAX <span style={{ color: 'var(--text-secondary)' }}>{da.maxVal.toFixed(2)}</span></span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Controls row */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          type="text"
          placeholder="Driver 1"
          value={driver1Input}
          onChange={e => setDriver1Input(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          style={{ width: 85, textTransform: 'uppercase' }}
        />
        <input
          type="text"
          placeholder="Driver 2"
          value={driver2Input}
          onChange={e => setDriver2Input(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          style={{ width: 85, textTransform: 'uppercase' }}
        />
        <button
          className="topbar__btn topbar__btn--primary"
          onClick={handleLoad}
          disabled={loading || !driver1Input.trim()}
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 12px' }}
        >
          {loading ? '...' : 'Load'}
        </button>

        {/* Channel toggles */}
        <div style={{ display: 'flex', gap: '3px', marginLeft: '6px' }}>
          {(Object.keys(CHANNEL_META) as AeroChannel[]).map(ch => (
            <button
              key={ch}
              onClick={() => setChannel(ch)}
              style={{
                padding: '2px 8px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--fs-xs)',
                fontFamily: 'var(--font-mono)',
                fontWeight: 500,
                background: channel === ch ? 'var(--bg-active)' : 'transparent',
                color: channel === ch ? 'var(--text-primary)' : 'var(--text-tertiary)',
                border: `1px solid ${channel === ch ? 'var(--border-emphasis)' : 'var(--border-default)'}`,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {CHANNEL_META[ch].label}
            </button>
          ))}
        </div>

        {/* Dot size */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
          <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>Size</span>
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={dotSize}
            onChange={e => setDotSize(Number(e.target.value))}
            style={{ width: 50, accentColor: 'var(--accent-teal)' }}
          />
        </div>
      </div>

      {/* Channel description */}
      <div className="text-tertiary" style={{ fontSize: 'var(--fs-xs)', marginBottom: '6px', fontStyle: 'italic', flexShrink: 0 }}>
        {CHANNEL_META[channel].desc}
      </div>

      {error && <div className="state-error" style={{ minHeight: 36, fontSize: 'var(--fs-sm)' }}>{error}</div>}
      {driverAero.length === 0 && !loading && (
        <div className="state-empty" style={{ minHeight: 100 }}>
          Enter one or two driver codes and press Load to visualise aero characteristics
        </div>
      )}

      {/* Map renders */}
      {driverAero.length > 0 && (
        <>
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '16px',
            flex: 1,
            minHeight: 0,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}>
            {driverAero.map((da, i) => renderMap(da, i))}
          </div>

          {/* Shared legend */}
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: '8px', marginTop: '8px', flexShrink: 0,
          }}>
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
              {globalBounds.min.toFixed(1)} {CHANNEL_META[channel].unit}
            </span>
            <div style={{
              width: 140, height: 8, borderRadius: 4,
              background: CHANNEL_META[channel].gradient,
            }} />
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
              {globalBounds.max.toFixed(1)} {CHANNEL_META[channel].unit}
            </span>
          </div>
        </>
      )}
    </div>
  );
};

registerPanel({
  id: 'aero-map',
  title: 'Aero Map',
  category: 'telemetry',
  Component: AeroMapPanel,
});

export default AeroMapPanel;
