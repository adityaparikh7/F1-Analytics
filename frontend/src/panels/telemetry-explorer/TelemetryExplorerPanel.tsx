/**
 * F1 Pitwall — Telemetry Explorer Panel
 *
 * Multi-channel telemetry comparison. Speed, throttle, brake, gear, DRS.
 * Uses SVG for rendering. Supports selecting two drivers.
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, LapData, CornerData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour, adjustColorLightness, DRIVER_TEAMS } from '../../lib/colours';
import { formatLapTime, formatSectorTime } from '../../lib/format';

const CHANNELS = ['speed', 'throttle', 'brake', 'gear'] as const;
type Channel = typeof CHANNELS[number];

const CHANNEL_CONFIG: Record<Channel, { label: string; unit: string; min: number; max: number; colour: string }> = {
  speed: { label: 'Speed', unit: 'km/h', min: 0, max: 370, colour: 'var(--text-primary)' },
  throttle: { label: 'Throttle', unit: '%', min: 0, max: 100, colour: 'var(--accent-teal)' },
  brake: { label: 'Brake', unit: '%', min: 0, max: 100, colour: 'var(--accent-red)' },
  gear: { label: 'Gear', unit: '', min: 0, max: 8, colour: 'var(--accent-amber)' },
};

const TelemetryExplorerPanel: React.FC<PanelProps> = ({ sessionKey, width, height }) => {
  const navigate = useNavigate();
  const [driver1, setDriver1] = useState('');
  const [driver2, setDriver2] = useState('');
  const [tel1, setTel1] = useState<TelemetryResponse | null>(null);
  const [tel2, setTel2] = useState<TelemetryResponse | null>(null);
  const [lap1, setLap1] = useState<LapData | null>(null);
  const [lap2, setLap2] = useState<LapData | null>(null);
  const [circuit, setCircuit] = useState<CornerData[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChannels, setActiveChannels] = useState<Set<Channel>>(new Set(['speed', 'throttle', 'gear']));
  
  // Interactivity state
  const [hoverX, setHoverX] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionKey) return;
    api.getCircuitInfo(sessionKey)
      .then(setCircuit)
      .catch(err => console.warn('Failed to load circuit info', err));
  }, [sessionKey]);

  const fetchTelemetryAndLap = async (driver: string, setTel: (d: TelemetryResponse) => void, setLap: (d: LapData) => void) => {
    if (!sessionKey || !driver) return;
    const [telData, lapsData] = await Promise.all([
      api.getTelemetry(sessionKey, driver, 'fastest', 4),
      api.getLaps(sessionKey, { driver })
    ]);
    setTel(telData);
    
    // Attempt to find the lap corresponding to PB, or just the best lap time overall
    const bestLap = lapsData.find(l => l.is_personal_best) 
      || lapsData.sort((a, b) => (a.lap_time || 9999) - (b.lap_time || 9999))[0] 
      || null;
    setLap(bestLap);
  };

  const handleLoad = async () => {
    if (!driver1) return;
    setLoading(true);
    setError(null);
    setTel1(null);
    setTel2(null);
    setLap1(null);
    setLap2(null);

    try {
      await fetchTelemetryAndLap(driver1, setTel1, setLap1);
      if (driver2) {
        await fetchTelemetryAndLap(driver2, setTel2, setLap2);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggleChannel = (ch: Channel) => {
    setActiveChannels(prev => {
      const next = new Set(prev);
      if (next.has(ch)) { if (next.size > 1) next.delete(ch); }
      else next.add(ch);
      return next;
    });
  };

  const maxDist = useMemo(() => {
    let m = 1;
    if (tel1) m = Math.max(m, ...tel1.data.map(d => d.distance || 0));
    if (tel2) m = Math.max(m, ...tel2.data.map(d => d.distance || 0));
    return m;
  }, [tel1, tel2]);

  // Highlight points (Top Speed)
  const topSpeed1 = useMemo(() => {
    if (!tel1) return null;
    return tel1.data.reduce((max, pt) => (pt.speed || 0) > (max.speed || 0) ? pt : max, tel1.data[0]);
  }, [tel1]);

  const topSpeed2 = useMemo(() => {
    if (!tel2) return null;
    return tel2.data.reduce((max, pt) => (pt.speed || 0) > (max.speed || 0) ? pt : max, tel2.data[0]);
  }, [tel2]);

  // Determine driver colors, handling same team scenario
  const driverColours = useMemo(() => {
    const defaultC1 = tel1 ? getDriverColour(tel1.driver, lap1?.team) : '#ff0000';
    const defaultC2 = tel2 ? getDriverColour(tel2.driver, lap2?.team) : '#00d5ff';

    if (!tel1 || !tel2) {
      return { color1: defaultC1, color2: defaultC2 };
    }

    const team1 = lap1?.team || DRIVER_TEAMS[tel1.driver];
    const team2 = lap2?.team || DRIVER_TEAMS[tel2.driver];

    // If they belong to the same team (or resolve to the same color), adjust driver 2's color shade
    if ((team1 && team2 && team1 === team2) || defaultC1 === defaultC2) {
      return {
        color1: defaultC1,
        color2: adjustColorLightness(defaultC2, 25)
      };
    }

    return { color1: defaultC1, color2: defaultC2 };
  }, [tel1, tel2, lap1, lap2]);

  if (!sessionKey) return <div className="state-empty">Select a session to explore telemetry</div>;

  const chartW = Math.max(width - 20, 300);
  const availableH = Math.max(height - 130, 200); 
  const activeArr = Array.from(activeChannels);
  const padL = 50, padR = 10, padT = 15, padB = 20;
  
  const svgH = Math.floor(availableH / activeArr.length);
  const plotW = chartW - padL - padR;
  const plotH = svgH - padT - padB;

  // Interactivity calculations
  const findClosest = (tel: TelemetryResponse | null, x: number) => {
    if (!tel || !tel.data.length || x < padL || x > padL + plotW) return null;
    const targetDist = ((x - padL) / plotW) * maxDist;
    // Simple linear scan for closest point (data is already downsampled)
    let closest = tel.data[0];
    let minDiff = Math.abs((closest.distance || 0) - targetDist);
    for (const pt of tel.data) {
      const diff = Math.abs((pt.distance || 0) - targetDist);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }
    return closest;
  };

  const hoverPt1 = hoverX !== null ? findClosest(tel1, hoverX) : null;
  const hoverPt2 = hoverX !== null ? findClosest(tel2, hoverX) : null;

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x >= padL && x <= padL + plotW) setHoverX(x);
    else setHoverX(null);
  };

  const renderTraceForChannel = (tel: TelemetryResponse | null, colour: string, ch: Channel) => {
    if (!tel || tel.data.length === 0) return null;
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
  };

  const renderLapInfo = (lap: LapData | null, tel: TelemetryResponse | null, colour: string) => {
    if (!lap && !tel) return null;
    return (
      <div style={{ flex: 1, padding: '4px 8px', borderLeft: `3px solid ${colour}`, background: 'var(--bg-elevated)', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
        <div style={{ fontWeight: 600, color: colour, marginBottom: 2 }}>{tel?.driver || lap?.driver}</div>
        <div style={{ display: 'flex', gap: '12px', color: 'var(--text-secondary)' }}>
          <span><span style={{color: 'var(--text-tertiary)'}}>LAP</span> {formatLapTime(lap?.lap_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S1</span> {formatSectorTime(lap?.sector1_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S2</span> {formatSectorTime(lap?.sector2_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S3</span> {formatSectorTime(lap?.sector3_time)}</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <input type="text" placeholder="Driver 1 (e.g. VER or 1)" value={driver1}
          onChange={e => setDriver1(e.target.value.toUpperCase())}
          style={{ width: 90, textTransform: 'uppercase' }} />
        <input type="text" placeholder="Driver 2 (e.g. 44)" value={driver2}
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
        <button 
          className="btn btn--outline" 
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', marginLeft: 'auto' }}
          onClick={() => navigate('/telemetry')}
          title="Open Full Page Analysis"
        >
          ⤢ Expand
        </button>
      </div>

      {error && <div className="state-error" style={{ minHeight: 40, fontSize: 'var(--fs-sm)', flexShrink: 0 }}>{error}</div>}

      {!tel1 && !loading && <div className="state-empty" style={{ minHeight: 100 }}>Enter driver codes above and click Load</div>}

      {/* Lap Info Bar */}
      {(tel1 || tel2) && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexShrink: 0 }}>
          {renderLapInfo(lap1, tel1, driverColours.color1)}
          {renderLapInfo(lap2, tel2, driverColours.color2)}
        </div>
      )}

      {/* Charts Grid */}
      {(tel1 || loading) && (
        <div 
          ref={containerRef}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverX(null)}
        >
          {activeArr.map(ch => {
            const cfg = CHANNEL_CONFIG[ch];
            return (
              <div key={ch} style={{ position: 'relative', height: svgH }}>
                <div style={{ position: 'absolute', top: 0, left: padL + 5, fontSize: 10, fontWeight: 600, color: cfg.colour }}>
                  {cfg.label} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>({cfg.unit})</span>
                </div>
                <svg width={chartW} height={svgH} style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                  {/* Grid */}
                  {Array.from({ length: 5 }, (_, i) => padT + (plotH * i) / 4).map((y, i) => (
                    <line key={i} x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-default)" strokeDasharray="2,4" />
                  ))}
                  
                  {/* Corner Markers */}
                  {circuit.map(corner => {
                    if (!corner.distance || corner.distance > maxDist) return null;
                    const cx = padL + (corner.distance / maxDist) * plotW;
                    return (
                      <g key={`corner-${corner.number}`}>
                        <line x1={cx} y1={padT} x2={cx} y2={padT + plotH} stroke="var(--border-default)" strokeDasharray="2,2" strokeOpacity={0.4} />
                        <text x={cx} y={padT - 3} fill="var(--text-tertiary)" fontSize={8} textAnchor="middle">{corner.number}</text>
                      </g>
                    );
                  })}

                  {/* Top Speed Highlights (only on speed channel) */}
                  {ch === 'speed' && (
                    <>
                      {topSpeed1 && (
                        <g>
                          <circle cx={padL + (topSpeed1.distance! / maxDist) * plotW} cy={padT + plotH - ((topSpeed1.speed! - cfg.min) / (cfg.max - cfg.min)) * plotH} r={3} fill={driverColours.color1} />
                          <text x={padL + (topSpeed1.distance! / maxDist) * plotW} y={padT + plotH - ((topSpeed1.speed! - cfg.min) / (cfg.max - cfg.min)) * plotH - 6} fill="var(--text-primary)" fontSize={8} textAnchor="middle" fontWeight={700}>{topSpeed1.speed} km/h</text>
                        </g>
                      )}
                      {topSpeed2 && (tel2) && (
                        <g>
                          <circle cx={padL + (topSpeed2.distance! / maxDist) * plotW} cy={padT + plotH - ((topSpeed2.speed! - cfg.min) / (cfg.max - cfg.min)) * plotH} r={3} fill={driverColours.color2} />
                          <text x={padL + (topSpeed2.distance! / maxDist) * plotW} y={padT + plotH - ((topSpeed2.speed! - cfg.min) / (cfg.max - cfg.min)) * plotH + 12} fill="var(--text-primary)" fontSize={8} textAnchor="middle" fontWeight={700}>{topSpeed2.speed} km/h</text>
                        </g>
                      )}
                    </>
                  )}

                  {/* Traces */}
                  {renderTraceForChannel(tel1, driverColours.color1, ch)}
                  {renderTraceForChannel(tel2, driverColours.color2, ch)}
                  
                  {/* Y-axis labels (min/max) */}
                  <text x={padL - 5} y={padT + 3} fill="var(--text-tertiary)" fontSize={9} textAnchor="end" alignmentBaseline="middle">{cfg.max}</text>
                  <text x={padL - 5} y={padT + plotH + 3} fill="var(--text-tertiary)" fontSize={9} textAnchor="end" alignmentBaseline="middle">{cfg.min}</text>

                  {/* Hover Crosshair */}
                  {hoverX !== null && (
                    <line x1={hoverX} y1={padT} x2={hoverX} y2={padT + plotH} stroke="var(--accent-teal)" strokeWidth={1} opacity={0.5} />
                  )}
                </svg>
              </div>
            );
          })}

          {/* Hover Tooltip */}
          {hoverX !== null && (
            <div style={{
              position: 'absolute', 
              left: hoverX + 15 > chartW - 100 ? hoverX - 110 : hoverX + 15, 
              top: 20,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-emphasis)',
              borderRadius: '4px', padding: '6px', fontSize: '10px', pointerEvents: 'none',
              zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: '90px',
              fontFamily: 'var(--font-mono)'
            }}>
              <div style={{ color: 'var(--text-tertiary)', marginBottom: '4px', borderBottom: '1px solid var(--border-default)', paddingBottom: '2px' }}>
                DIST: {Math.round((hoverX - padL) / plotW * maxDist)}m
              </div>
              {tel1 && hoverPt1 && (
                <div style={{ color: driverColours.color1, marginBottom: '4px' }}>
                  <div style={{ fontWeight: 700 }}>{tel1.driver}</div>
                  {activeArr.map(ch => (
                    <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <span>{ch.toUpperCase()}:</span>
                      <span>{hoverPt1[ch]}{CHANNEL_CONFIG[ch].unit}</span>
                    </div>
                  ))}
                </div>
              )}
              {tel2 && hoverPt2 && (
                <div style={{ color: driverColours.color2, paddingTop: '4px', borderTop: '1px solid var(--border-default)' }}>
                  <div style={{ fontWeight: 700 }}>{tel2.driver}</div>
                  {activeArr.map(ch => (
                    <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <span>{ch.toUpperCase()}:</span>
                      <span>{hoverPt2[ch]}{CHANNEL_CONFIG[ch].unit}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

registerPanel({ id: 'telemetry-explorer', title: 'Telemetry Explorer', category: 'telemetry', Component: TelemetryExplorerPanel });
export default TelemetryExplorerPanel;
