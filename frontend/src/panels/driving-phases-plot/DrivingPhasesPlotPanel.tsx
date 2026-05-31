/**
 * F1 Pitwall — Driving Phases Plot Panel
 *
 * Scatter-plot of every telemetry sample on the circuit map,
 * with each point coloured by speed, throttle or brake. Shows braking zones,
 * acceleration zones, and top-speed traps at a glance.
 *
 * Supports loading multiple drivers simultaneously and toggling
 * between speed, throttle, and brake as the colour channel.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse } from '../../lib/api';
import { api } from '../../lib/api';

type HeatChannel = 'speed' | 'throttle' | 'brake';

const CHANNEL_META: Record<HeatChannel, { label: string; unit: string; gradient: string }> = {
  speed: {
    label: 'Speed',
    unit: 'km/h',
    gradient: 'linear-gradient(90deg, #0064FF, #00FF9B, #FFFF00, #FF3700)',
  },
  throttle: {
    label: 'Throttle',
    unit: '%',
    gradient: 'linear-gradient(90deg, #1a1a2e, #00D2BE, #39B54A)',
  },
  brake: {
    label: 'Brake',
    unit: '%',
    gradient: 'linear-gradient(90deg, #1a1a2e, #E8002D, #FFC906)',
  },
};

function channelToColour(value: number, min: number, max: number, channel: HeatChannel): string {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));

  if (channel === 'speed') {
    // Blue → Cyan → Green → Yellow → Red
    if (t < 0.25) {
      const s = t / 0.25;
      return `rgb(${Math.round(0)}, ${Math.round(100 + s * 155)}, ${Math.round(255 - s * 100)})`;
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      return `rgb(${Math.round(s * 100)}, 255, ${Math.round(155 - s * 155)})`;
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      return `rgb(${Math.round(100 + s * 155)}, 255, 0)`;
    } else {
      const s = (t - 0.75) / 0.25;
      return `rgb(255, ${Math.round(255 - s * 200)}, 0)`;
    }
  } else if (channel === 'throttle') {
    // Dark → Teal → Green
    return `rgb(${Math.round(t * 57)}, ${Math.round(26 + t * 229)}, ${Math.round(46 + t * 144)})`;
  } else {
    // Dark → Red → Amber
    if (t < 0.6) {
      const s = t / 0.6;
      return `rgb(${Math.round(26 + s * 206)}, ${Math.round(26 - s * 26)}, ${Math.round(46 - s * 1)})`;
    } else {
      const s = (t - 0.6) / 0.4;
      return `rgb(${Math.round(232 + s * 23)}, ${Math.round(s * 201)}, ${Math.round(45 * s)})`;
    }
  }
}

const DrivingPhasesPlotPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [driverInput, setDriverInput] = useState('');
  const [telData, setTelData] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<HeatChannel>('speed');
  const [dotSize, setDotSize] = useState(2);

  const handleLoad = useCallback(async () => {
    if (!sessionKey || !driverInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTelemetry(sessionKey, driverInput.trim(), 'fastest', 1);
      setTelData(data);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [sessionKey, driverInput]);

  // Compute rendering data
  const renderData = useMemo(() => {
    if (!telData) return null;
    const pts = telData.data.filter(d => d.x != null && d.y != null);
    if (pts.length === 0) return null;

    const xs = pts.map(d => d.x!);
    const ys = pts.map(d => d.y!);
    const values = pts.map(d => (d[channel] as number) ?? 0);

    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minVal = Math.min(...values), maxVal = Math.max(...values);

    return { pts, xs, ys, values, minX, maxX, minY, maxY, minVal, maxVal };
  }, [telData, channel]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view the top speed heatmap</div>;
  }

  const svgSize = Math.min(Math.max(width - 20, 200), Math.max(height - 90, 200));
  const pad = 15;

  return (
    <div>
      {/* Controls row */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Driver (e.g. NOR or 4)"
          value={driverInput}
          onChange={e => setDriverInput(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          style={{ width: 100, textTransform: 'uppercase' }}
        />
        <button
          className="topbar__btn topbar__btn--primary"
          onClick={handleLoad}
          disabled={loading || !driverInput.trim()}
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 12px' }}
        >
          {loading ? '...' : 'Load'}
        </button>

        {/* Channel toggles */}
        <div style={{ display: 'flex', gap: '3px', marginLeft: '6px' }}>
          {(Object.keys(CHANNEL_META) as HeatChannel[]).map(ch => (
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
            value={dotSize}
            onChange={e => setDotSize(Number(e.target.value))}
            style={{ width: 60, accentColor: 'var(--accent-teal)' }}
          />
        </div>

        {telData && (
          <span className="text-secondary mono" style={{ fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>
            {telData.driver} · {telData.sample_count} samples
          </span>
        )}
      </div>

      {error && <div className="state-error" style={{ minHeight: 40, fontSize: 'var(--fs-sm)' }}>{error}</div>}
      {!telData && !loading && (
        <div className="state-empty" style={{ minHeight: 120 }}>
          Enter a driver code and press Load to render the heatmap
        </div>
      )}

      {/* Heatmap render */}
      {renderData && (() => {
        const rangeX = renderData.maxX - renderData.minX || 1;
        const rangeY = renderData.maxY - renderData.minY || 1;
        const scale = (svgSize - pad * 2) / Math.max(rangeX, rangeY);
        
        const offsetX = (svgSize - rangeX * scale) / 2 - renderData.minX * scale;
        const offsetY = (svgSize - rangeY * scale) / 2 - renderData.minY * scale;
        
        const mapX = (x: number) => x * scale + offsetX;
        const mapY = (y: number) => svgSize - (y * scale + offsetY);

        return (
        <>
          <svg
            width={svgSize}
            height={svgSize}
            style={{ display: 'block', margin: '0 auto' }}
          >
            {/* Dark track outline */}
            <polyline
              points={renderData.pts.map(p => {
                const x = mapX(p.x!);
                const y = mapY(p.y!);
                return `${x},${y}`;
              }).join(' ')}
              fill="none"
              stroke="var(--border-default)"
              strokeWidth={dotSize + 4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Coloured dots */}
            {renderData.pts.map((p, i) => {
              const x = mapX(p.x!);
              const y = mapY(p.y!);
              const val = renderData.values[i];
              const colour = channelToColour(val, renderData.minVal, renderData.maxVal, channel);
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={dotSize}
                  fill={colour}
                  opacity={0.9}
                />
              );
            })}

            {/* Start/finish */}
            {renderData.pts.length > 0 && (() => {
              const p = renderData.pts[0];
              const x = mapX(p.x!);
              const y = mapY(p.y!);
              return <circle cx={x} cy={y} r={5} fill="none" stroke="var(--accent-red)" strokeWidth={2} />;
            })()}
          </svg>

          {/* Legend */}
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: '8px', marginTop: '6px',
          }}>
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
              {Math.round(renderData.minVal)}{CHANNEL_META[channel].unit}
            </span>
            <div style={{
              width: 130, height: 8, borderRadius: 4,
              background: CHANNEL_META[channel].gradient,
            }} />
            <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
              {Math.round(renderData.maxVal)}{CHANNEL_META[channel].unit}
            </span>
          </div>
        </>
      )})()}
    </div>
  );
};

registerPanel({
  id: 'driving-phases-plot',
  title: 'Driving Phases Plot',
  category: 'telemetry',
  Component: DrivingPhasesPlotPanel,
});

export default DrivingPhasesPlotPanel;
