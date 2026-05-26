/**
 * F1 Pitwall — Speed Trace / Aero Map Panel
 *
 * Overlays two drivers' speed traces against track distance.
 * Also shows DRS zones (highlighted bands) and gear shifts.
 * The bottom sub-chart shows throttle & brake traces for context.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, TelemetryPoint } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';

interface DriverTrace {
  tel: TelemetryResponse;
  colour: string;
}

const SpeedTracePanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const [driver1, setDriver1] = useState('');
  const [driver2, setDriver2] = useState('');
  const [traces, setTraces] = useState<DriverTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPedals, setShowPedals] = useState(true);

  const handleLoad = useCallback(async () => {
    if (!sessionKey || !driver1.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const driversToLoad = [driver1.trim()];
      if (driver2.trim()) driversToLoad.push(driver2.trim());

      const results: DriverTrace[] = [];
      for (const drv of driversToLoad) {
        const tel = await api.getTelemetry(sessionKey, drv, 'fastest', 2);
        results.push({ tel, colour: getDriverColour(drv) });
      }
      setTraces(results);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [sessionKey, driver1, driver2]);

  // Compute chart bounds
  const chartData = useMemo(() => {
    if (traces.length === 0) return null;

    let maxDist = 0;
    let maxSpeed = 0;

    for (const t of traces) {
      for (const p of t.tel.data) {
        if (p.distance != null && p.distance > maxDist) maxDist = p.distance;
        if (p.speed != null && p.speed > maxSpeed) maxSpeed = p.speed;
      }
    }

    // Round up for a clean axis
    maxSpeed = Math.ceil(maxSpeed / 50) * 50;

    return { maxDist, maxSpeed };
  }, [traces]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view speed traces</div>;
  }

  const chartW = Math.max(width - 20, 300);
  const speedH = showPedals ? Math.max((height - 90) * 0.65, 100) : Math.max(height - 70, 150);
  const pedalH = showPedals ? Math.max((height - 90) * 0.30, 60) : 0;
  const padL = 48, padR = 10, padT = 6, padB = 20;
  const plotW = chartW - padL - padR;

  // Scaling functions
  const xScale = (dist: number) => {
    if (!chartData) return padL;
    return padL + (dist / (chartData.maxDist || 1)) * plotW;
  };
  const speedYScale = (speed: number) => {
    if (!chartData) return padT;
    return padT + (speedH - padT - padB) * (1 - speed / (chartData.maxSpeed || 350));
  };
  const pedalYScale = (val: number) => {
    return 4 + (pedalH - 8) * (1 - val / 100);
  };

  // Build polyline points for a given trace and channel
  const buildPolyline = (data: TelemetryPoint[], channel: 'speed' | 'throttle' | 'brake', yFn: (v: number) => number): string => {
    return data
      .filter(p => p.distance != null && p[channel] != null)
      .map(p => `${xScale(p.distance!)},${yFn(p[channel] as number)}`)
      .join(' ');
  };

  // Find DRS zones from the first trace
  const drsZones = useMemo(() => {
    if (traces.length === 0) return [];
    const data = traces[0].tel.data.filter(p => p.distance != null);
    const zones: Array<{ start: number; end: number }> = [];
    let inZone = false;
    let zoneStart = 0;

    for (const p of data) {
      const isDrs = p.drs != null && (p.drs >= 10 || p.drs === 1);
      if (isDrs && !inZone) {
        inZone = true;
        zoneStart = p.distance!;
      } else if (!isDrs && inZone) {
        inZone = false;
        zones.push({ start: zoneStart, end: p.distance! });
      }
    }
    if (inZone && data.length > 0) {
      zones.push({ start: zoneStart, end: data[data.length - 1].distance! });
    }
    return zones;
  }, [traces]);

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Driver 1 (e.g. 1)"
          value={driver1}
          onChange={e => setDriver1(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          style={{ width: 85, textTransform: 'uppercase' }}
        />
        <input
          type="text"
          placeholder="Driver 2 (e.g. 44)"
          value={driver2}
          onChange={e => setDriver2(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handleLoad()}
          style={{ width: 85, textTransform: 'uppercase' }}
        />
        <button
          className="topbar__btn topbar__btn--primary"
          onClick={handleLoad}
          disabled={loading || !driver1.trim()}
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 12px' }}
        >
          {loading ? '...' : 'Load'}
        </button>

        <label style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          marginLeft: '8px', cursor: 'pointer',
          fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)',
        }}>
          <input
            type="checkbox"
            checked={showPedals}
            onChange={e => setShowPedals(e.target.checked)}
            style={{ accentColor: 'var(--accent-teal)' }}
          />
          Pedals
        </label>

        {/* Driver legend */}
        {traces.map(t => (
          <span key={t.tel.driver} style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
          }}>
            <span style={{ width: 10, height: 3, borderRadius: 1, background: t.colour }} />
            <span style={{ color: t.colour, fontWeight: 600 }}>{t.tel.driver}</span>
          </span>
        ))}
      </div>

      {error && <div className="state-error" style={{ minHeight: 36, fontSize: 'var(--fs-sm)' }}>{error}</div>}
      {traces.length === 0 && !loading && (
        <div className="state-empty" style={{ minHeight: 100 }}>Enter driver codes and click Load</div>
      )}

      {/* Speed trace chart */}
      {chartData && (
        <>
          <svg width={chartW} height={speedH} style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
            {/* DRS zones */}
            {drsZones.map((z, i) => (
              <rect
                key={i}
                x={xScale(z.start)}
                y={padT}
                width={xScale(z.end) - xScale(z.start)}
                height={speedH - padT - padB}
                fill="var(--accent-teal)"
                opacity={0.08}
              />
            ))}

            {/* Horizontal gridlines */}
            {Array.from({ length: 5 }, (_, i) => {
              const speed = (chartData.maxSpeed * (4 - i)) / 4;
              return (
                <g key={i}>
                  <line
                    x1={padL} y1={speedYScale(speed)}
                    x2={padL + plotW} y2={speedYScale(speed)}
                    stroke="var(--border-default)" strokeDasharray="2,4"
                  />
                  <text
                    x={padL - 4} y={speedYScale(speed) + 3}
                    fill="var(--text-tertiary)" textAnchor="end" fontSize={9}
                  >
                    {Math.round(speed)}
                  </text>
                </g>
              );
            })}

            {/* Y axis label */}
            <text
              x={10} y={speedH / 2}
              fill="var(--text-tertiary)" fontSize={8}
              transform={`rotate(-90, 10, ${speedH / 2})`}
              textAnchor="middle"
            >
              km/h
            </text>

            {/* Speed traces */}
            {traces.map(t => (
              <polyline
                key={t.tel.driver}
                points={buildPolyline(t.tel.data, 'speed', speedYScale)}
                fill="none"
                stroke={t.colour}
                strokeWidth={1.5}
                opacity={0.85}
              />
            ))}

            {/* Distance axis */}
            {Array.from({ length: 6 }, (_, i) => {
              const dist = (chartData.maxDist * i) / 5;
              return (
                <text
                  key={i}
                  x={xScale(dist)} y={speedH - 4}
                  fill="var(--text-tertiary)" textAnchor="middle" fontSize={8}
                >
                  {(dist / 1000).toFixed(1)}km
                </text>
              );
            })}
          </svg>

          {/* Pedal chart */}
          {showPedals && (
            <svg width={chartW} height={pedalH} style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
              {/* Gridlines at 50% and 100% */}
              <line x1={padL} y1={pedalYScale(50)} x2={padL + plotW} y2={pedalYScale(50)} stroke="var(--border-default)" strokeDasharray="2,4" />
              <line x1={padL} y1={pedalYScale(100)} x2={padL + plotW} y2={pedalYScale(100)} stroke="var(--border-default)" strokeDasharray="2,4" />

              {/* Throttle traces */}
              {traces.map(t => (
                <polyline
                  key={`${t.tel.driver}-thr`}
                  points={buildPolyline(t.tel.data, 'throttle', pedalYScale)}
                  fill="none"
                  stroke="var(--accent-teal)"
                  strokeWidth={1}
                  opacity={0.5}
                />
              ))}

              {/* Brake traces */}
              {traces.map(t => (
                <polyline
                  key={`${t.tel.driver}-brk`}
                  points={buildPolyline(t.tel.data, 'brake', pedalYScale)}
                  fill="none"
                  stroke="var(--accent-red)"
                  strokeWidth={1}
                  opacity={0.5}
                />
              ))}

              {/* Labels */}
              <text x={padL - 4} y={pedalYScale(100) + 3} fill="var(--text-tertiary)" textAnchor="end" fontSize={8}>100%</text>
              <text x={padL - 4} y={pedalYScale(0) + 3} fill="var(--text-tertiary)" textAnchor="end" fontSize={8}>0%</text>

              {/* Tiny legend */}
              <text x={padL + 4} y={12} fill="var(--accent-teal)" fontSize={8}>THR</text>
              <text x={padL + 30} y={12} fill="var(--accent-red)" fontSize={8}>BRK</text>
            </svg>
          )}
        </>
      )}
    </div>
  );
};

registerPanel({
  id: 'speed-trace',
  title: 'Speed Trace',
  category: 'telemetry',
  Component: SpeedTracePanel,
});

export default SpeedTracePanel;
