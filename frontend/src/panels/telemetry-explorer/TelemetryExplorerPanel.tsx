/**
 * F1 Pitwall — Telemetry Explorer Panel
 *
 * Multi-channel telemetry comparison. Speed, throttle, brake, gear, DRS.
 * Uses SVG for rendering. Supports selecting two drivers.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';

const CHANNELS = ['speed', 'throttle', 'brake', 'gear'] as const;
type Channel = typeof CHANNELS[number];

const CHANNEL_CONFIG: Record<Channel, { label: string; unit: string; min: number; max: number; colour: string }> = {
  speed: { label: 'Speed', unit: 'km/h', min: 0, max: 370, colour: 'var(--text-primary)' },
  throttle: { label: 'Throttle', unit: '%', min: 0, max: 100, colour: 'var(--accent-teal)' },
  brake: { label: 'Brake', unit: '%', min: 0, max: 100, colour: 'var(--accent-red)' },
  gear: { label: 'Gear', unit: '', min: 0, max: 8, colour: 'var(--accent-amber)' },
};

const TelemetryExplorerPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [driver1, setDriver1] = useState('');
  const [driver2, setDriver2] = useState('');
  const [tel1, setTel1] = useState<TelemetryResponse | null>(null);
  const [tel2, setTel2] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChannels, setActiveChannels] = useState<Set<Channel>>(new Set(['speed']));

  const fetchTelemetry = async (driver: string, setter: (d: TelemetryResponse) => void) => {
    if (!sessionKey || !driver) return;
    try {
      const data = await api.getTelemetry(sessionKey, driver, 'fastest', 4);
      setter(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLoad = async () => {
    if (!driver1) return;
    setLoading(true);
    setError(null);
    setTel1(null);
    setTel2(null);
    await fetchTelemetry(driver1, setTel1);
    if (driver2) await fetchTelemetry(driver2, setTel2);
    setLoading(false);
  };

  const toggleChannel = (ch: Channel) => {
    setActiveChannels(prev => {
      const next = new Set(prev);
      if (next.has(ch)) { if (next.size > 1) next.delete(ch); }
      else next.add(ch);
      return next;
    });
  };

  if (!sessionKey) return <div className="state-empty">Select a session to explore telemetry</div>;

  const chartW = Math.max(width - 20, 300);
  const chartH = Math.max(height - 80, 150);
  const padL = 50, padR = 10, padT = 8, padB = 20;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const renderTrace = (tel: TelemetryResponse | null, colour: string) => {
    if (!tel || tel.data.length === 0) return null;
    const maxDist = Math.max(...tel.data.map(d => d.distance || 0), 1);

    return Array.from(activeChannels).map(ch => {
      const cfg = CHANNEL_CONFIG[ch];
      const points = tel.data
        .filter(d => d.distance != null && d[ch] != null)
        .map(d => {
          const x = padL + ((d.distance! / maxDist) * plotW);
          const val = Math.min(Math.max(d[ch] as number, cfg.min), cfg.max);
          const y = padT + plotH - ((val - cfg.min) / (cfg.max - cfg.min)) * plotH;
          return `${x},${y}`;
        });
      if (points.length < 2) return null;
      return (
        <polyline
          key={`${tel.driver}-${ch}`}
          points={points.join(' ')}
          fill="none"
          stroke={colour}
          strokeWidth={1.3}
          opacity={0.8}
        />
      );
    });
  };

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Driver 1 (e.g. VER)" value={driver1}
          onChange={e => setDriver1(e.target.value.toUpperCase())}
          style={{ width: 90, textTransform: 'uppercase' }} />
        <input type="text" placeholder="Driver 2" value={driver2}
          onChange={e => setDriver2(e.target.value.toUpperCase())}
          style={{ width: 90, textTransform: 'uppercase' }} />
        <button className="topbar__btn topbar__btn--primary" onClick={handleLoad}
          disabled={loading || !driver1} style={{ fontSize: 'var(--fs-xs)', padding: '3px 12px' }}>
          {loading ? '...' : 'Load'}
        </button>
        <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
          {CHANNELS.map(ch => (
            <button key={ch} onClick={() => toggleChannel(ch)} style={{
              padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-xs)',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              background: activeChannels.has(ch) ? 'var(--bg-active)' : 'transparent',
              color: activeChannels.has(ch) ? 'var(--text-primary)' : 'var(--text-tertiary)',
              border: `1px solid ${activeChannels.has(ch) ? 'var(--border-emphasis)' : 'var(--border-default)'}`,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
              {CHANNEL_CONFIG[ch].label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="state-error" style={{ minHeight: 40, fontSize: 'var(--fs-sm)' }}>{error}</div>}

      {!tel1 && !loading && <div className="state-empty" style={{ minHeight: 100 }}>Enter driver codes above and click Load</div>}

      {(tel1 || loading) && (
        <svg width={chartW} height={chartH} style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
          {/* Grid */}
          {Array.from({ length: 5 }, (_, i) => padT + (plotH * i) / 4).map((y, i) => (
            <line key={i} x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-default)" strokeDasharray="2,4" />
          ))}
          {/* Traces */}
          {renderTrace(tel1, tel1 ? getDriverColour(tel1.driver) : '#888')}
          {renderTrace(tel2, tel2 ? getDriverColour(tel2.driver) : '#666')}
          {/* Legend */}
          {tel1 && (
            <text x={padL + 4} y={padT + 12} fill={getDriverColour(tel1.driver)} fontSize={10} fontWeight={600}>{tel1.driver}</text>
          )}
          {tel2 && (
            <text x={padL + 44} y={padT + 12} fill={getDriverColour(tel2.driver)} fontSize={10} fontWeight={600}>{tel2.driver}</text>
          )}
        </svg>
      )}
    </div>
  );
};

registerPanel({ id: 'telemetry-explorer', title: 'Telemetry Explorer', category: 'telemetry', Component: TelemetryExplorerPanel });
export default TelemetryExplorerPanel;
