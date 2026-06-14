import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../store/sessionStore';
import type { TelemetryResponse, LapData, CornerData } from '../lib/api';
import { api } from '../lib/api';
import { getDriverColour, adjustColorLightness, DRIVER_TEAMS } from '../lib/colours';
import { formatLapTime, formatSectorTime } from '../lib/format';

const CHANNELS = ['delta', 'speed', 'throttle', 'brake', 'gear'] as const;
type Channel = typeof CHANNELS[number];

const CHANNEL_CONFIG: Record<Channel, { label: string; unit: string; min: number; max: number; colour: string }> = {
  delta: { label: 'Time Delta', unit: 's', min: -1.0, max: 1.0, colour: 'var(--text-primary)' },
  speed: { label: 'Speed', unit: 'km/h', min: 0, max: 370, colour: 'var(--text-primary)' },
  throttle: { label: 'Throttle', unit: '%', min: 0, max: 100, colour: 'var(--accent-teal)' },
  brake: { label: 'Brake', unit: '%', min: 0, max: 1, colour: 'var(--accent-red)' },
  gear: { label: 'Gear', unit: '', min: 0, max: 8, colour: 'var(--accent-amber)' },
};

const getCompoundShort = (compound: string | null) => {
  if (!compound) return '?';
  const c = compound.toUpperCase();
  if (c === 'SOFT') return 'S';
  if (c === 'MEDIUM') return 'M';
  if (c === 'HARD') return 'H';
  if (c === 'INTERMEDIATE') return 'I';
  if (c === 'WET') return 'W';
  return '?';
};

const TelemetryPage: React.FC = () => {
  const navigate = useNavigate();
  const { activeSessionKey, sessions } = useSessionStore();
  const session = sessions.find(s => s.session_key === activeSessionKey);

  const [allLaps, setAllLaps] = useState<LapData[]>([]);
  const [circuit, setCircuit] = useState<CornerData[]>([]);

  const [driver1, setDriver1] = useState('');
  const [lapNumber1, setLapNumber1] = useState<number | ''>('');
  
  const [driver2, setDriver2] = useState('');
  const [lapNumber2, setLapNumber2] = useState<number | ''>('');

  const [tel1, setTel1] = useState<TelemetryResponse | null>(null);
  const [tel2, setTel2] = useState<TelemetryResponse | null>(null);

  const [activeChannels, setActiveChannels] = useState<Set<Channel>>(new Set(['delta', 'speed', 'throttle', 'brake', 'gear']));
  
  const [loadingLaps, setLoadingLaps] = useState(false);
  const [loadingTel, setLoadingTel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hoverX, setHoverX] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [tel1, tel2]); // Re-observe if elements change

  useEffect(() => {
    if (!activeSessionKey) return;
    setLoadingLaps(true);
    setError(null);
    
    Promise.all([
      api.getLaps(activeSessionKey),
      api.getCircuitInfo(activeSessionKey).catch(() => [] as CornerData[])
    ])
      .then(([lapData, circuitData]) => {
        setAllLaps(lapData);
        setCircuit(circuitData);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoadingLaps(false));
  }, [activeSessionKey]);

  const drivers = useMemo(() => {
    const set = new Set<string>();
    allLaps.forEach(l => set.add(l.driver));
    return Array.from(set).sort();
  }, [allLaps]);

  const getDriverLaps = (drv: string) => {
    return allLaps
      .filter(l => l.driver === drv && l.lap_time != null && l.lap_time > 0)
      .sort((a, b) => a.lap_number - b.lap_number);
  };

  const handleDriverChange = (driverIndex: 1 | 2, drv: string) => {
    const setDriver = driverIndex === 1 ? setDriver1 : setDriver2;
    const setLapNum = driverIndex === 1 ? setLapNumber1 : setLapNumber2;
    
    setDriver(drv);
    if (drv) {
      const laps = getDriverLaps(drv);
      const best = laps.length ? laps.reduce((a, b) => (a.lap_time! < b.lap_time! ? a : b)) : null;
      setLapNum(best ? best.lap_number : '');
    } else {
      setLapNum('');
    }
  };

  const handleLoad = async () => {
    if (!activeSessionKey) return;
    setLoadingTel(true);
    setError(null);
    setTel1(null);
    setTel2(null);

    try {
      const promises = [];
      if (driver1 && lapNumber1) {
        promises.push(api.getTelemetry(activeSessionKey, driver1, String(lapNumber1)).then(setTel1));
      }
      if (driver2 && lapNumber2) {
        promises.push(api.getTelemetry(activeSessionKey, driver2, String(lapNumber2)).then(setTel2));
      }
      await Promise.all(promises);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingTel(false);
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

  const activeLap1 = useMemo(() => allLaps.find(l => l.driver === driver1 && l.lap_number === lapNumber1) || null, [allLaps, driver1, lapNumber1]);
  const activeLap2 = useMemo(() => allLaps.find(l => l.driver === driver2 && l.lap_number === lapNumber2) || null, [allLaps, driver2, lapNumber2]);

  const driverColours = useMemo(() => {
    const defaultC1 = tel1 ? getDriverColour(tel1.driver, activeLap1?.team) : '#ff0000';
    const defaultC2 = tel2 ? getDriverColour(tel2.driver, activeLap2?.team) : '#00d5ff';

    if (!tel1 || !tel2) return { color1: defaultC1, color2: defaultC2 };

    const team1 = activeLap1?.team || DRIVER_TEAMS[tel1.driver];
    const team2 = activeLap2?.team || DRIVER_TEAMS[tel2.driver];

    if ((team1 && team2 && team1 === team2) || defaultC1 === defaultC2) {
      return { color1: defaultC1, color2: adjustColorLightness(defaultC2, 25) };
    }
    return { color1: defaultC1, color2: defaultC2 };
  }, [tel1, tel2, activeLap1, activeLap2]);

  const maxDist = useMemo(() => {
    let m = 1;
    if (tel1) m = Math.max(m, ...tel1.data.map(d => d.distance || 0));
    if (tel2) m = Math.max(m, ...tel2.data.map(d => d.distance || 0));
    return m;
  }, [tel1, tel2]);

  const deltaTrace = useMemo(() => {
    if (!tel1 || !tel2 || !tel1.data.length || !tel2.data.length) return null;
    
    const d1 = tel1.data.filter(d => d.distance != null && d.time != null);
    const d2 = tel2.data.filter(d => d.distance != null && d.time != null);
    if (!d1.length || !d2.length) return null;

    const interpolateTime = (x: number) => {
      let rightIdx = d2.findIndex(d => d.distance! >= x);
      if (rightIdx === -1) return d2[d2.length - 1].time!;
      if (rightIdx === 0) return d2[0].time!;
      const left = d2[rightIdx - 1];
      const right = d2[rightIdx];
      const dx = right.distance! - left.distance!;
      if (dx === 0) return left.time!;
      const ratio = (x - left.distance!) / dx;
      return left.time! + ratio * (right.time! - left.time!);
    };

    let minDelta = 0;
    let maxDelta = 0;

    const points = d1.map(p1 => {
      const t2 = interpolateTime(p1.distance!);
      const dt = t2 - p1.time!;
      if (dt < minDelta) minDelta = dt;
      if (dt > maxDelta) maxDelta = dt;
      return { distance: p1.distance!, delta: dt };
    });

    const range = Math.max(Math.abs(minDelta), Math.abs(maxDelta), 0.5) * 1.2;
    return { points, min: -range, max: range };
  }, [tel1, tel2]);

  if (!activeSessionKey) {
    return (
      <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <h2 style={{ marginBottom: 'var(--space-4)' }}>No Session Selected</h2>
        <button className="btn btn--primary" onClick={() => navigate('/')}>Return to Dashboard</button>
      </div>
    );
  }

  const chartW = dimensions.width;
  const activeArr = Array.from(activeChannels);
  const padL = 50, padR = 10, padT = 15, padB = 20;
  
  const svgH = Math.max(100, Math.floor((dimensions.height) / activeArr.length));
  const plotW = chartW - padL - padR;
  const plotH = svgH - padT - padB;

  const findClosest = (tel: TelemetryResponse | null, x: number) => {
    if (!tel || !tel.data.length || x < padL || x > padL + plotW) return null;
    const targetDist = ((x - padL) / plotW) * maxDist;
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

  const hoverDelta = useMemo(() => {
    if (!deltaTrace || hoverX === null) return null;
    const targetDist = ((hoverX - padL) / plotW) * maxDist;
    let closest = deltaTrace.points[0];
    let minDiff = Math.abs((closest.distance || 0) - targetDist);
    for (const pt of deltaTrace.points) {
      const diff = Math.abs((pt.distance || 0) - targetDist);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }
    return closest;
  }, [deltaTrace, hoverX, padL, plotW, maxDist]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x >= padL && x <= padL + plotW) setHoverX(x);
    else setHoverX(null);
  };

  const renderTraceForChannel = (tel: TelemetryResponse | null, colour: string, ch: Channel) => {
    if (ch === 'delta') return null;
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
        strokeWidth={1.5}
        opacity={0.85}
      />
    );
  };

  const renderLapInfo = (lap: LapData | null, tel: TelemetryResponse | null, colour: string, label: string) => {
    if (!lap && !tel) return <div style={{ flex: 1, padding: '8px', background: 'var(--bg-elevated)', borderRadius: '4px', opacity: 0.5 }}>{label} not loaded</div>;
    return (
      <div style={{ flex: 1, padding: '8px 12px', borderLeft: `4px solid ${colour}`, background: 'var(--bg-elevated)', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>
        <div style={{ fontWeight: 700, color: colour, marginBottom: 4, fontSize: 'var(--fs-sm)' }}>{tel?.driver || lap?.driver} - Lap {lap?.lap_number || 'N/A'} ({getCompoundShort(lap?.compound || null)})</div>
        <div style={{ display: 'flex', gap: '16px', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
          <span><span style={{color: 'var(--text-tertiary)'}}>TIME</span> {formatLapTime(lap?.lap_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S1</span> {formatSectorTime(lap?.sector1_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S2</span> {formatSectorTime(lap?.sector2_time)}</span>
          <span><span style={{color: 'var(--text-tertiary)'}}>S3</span> {formatSectorTime(lap?.sector3_time)}</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-4)', flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Telemetry Analysis
          </h1>
          <p style={{ color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
            {session?.event_name} {session?.year} — {session?.session_type}
          </p>
        </div>
        <button className="btn btn--outline" onClick={() => navigate('/')}>
          Back to Dashboard
        </button>
      </div>

      {/* Controls */}
      <div style={{ background: 'var(--surface-primary)', padding: 'var(--space-4)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', marginBottom: 'var(--space-4)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
          
          {/* Trace 1 Controls */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', width: '60px' }}>Trace 1</div>
            <select value={driver1} onChange={e => handleDriverChange(1, e.target.value)} style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-default)', padding: '4px 8px', borderRadius: '4px', color: 'var(--text-primary)' }}>
              <option value="">Driver</option>
              {drivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={lapNumber1} onChange={e => setLapNumber1(Number(e.target.value))} disabled={!driver1} style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-default)', padding: '4px 8px', borderRadius: '4px', color: 'var(--text-primary)', minWidth: '150px' }}>
              <option value="">Select Lap</option>
              {getDriverLaps(driver1).map(l => (
                <option key={l.lap_number} value={l.lap_number}>Lap {l.lap_number} — {formatLapTime(l.lap_time)} ({getCompoundShort(l.compound)})</option>
              ))}
            </select>
          </div>

          {/* Trace 2 Controls */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', width: '60px' }}>Trace 2</div>
            <select value={driver2} onChange={e => handleDriverChange(2, e.target.value)} style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-default)', padding: '4px 8px', borderRadius: '4px', color: 'var(--text-primary)' }}>
              <option value="">Driver</option>
              {drivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={lapNumber2} onChange={e => setLapNumber2(Number(e.target.value))} disabled={!driver2} style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-default)', padding: '4px 8px', borderRadius: '4px', color: 'var(--text-primary)', minWidth: '150px' }}>
              <option value="">Select Lap</option>
              {getDriverLaps(driver2).map(l => (
                <option key={l.lap_number} value={l.lap_number}>Lap {l.lap_number} — {formatLapTime(l.lap_time)} ({getCompoundShort(l.compound)})</option>
              ))}
            </select>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              {CHANNELS.map(ch => (
                <button key={ch} onClick={() => toggleChannel(ch)} style={{
                  padding: '4px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-sm)',
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
            
            <button className="btn btn--primary" onClick={handleLoad} disabled={loadingTel || (!driver1 && !driver2) || (!!driver1 && !lapNumber1) || (!!driver2 && !lapNumber2)}>
              {loadingTel ? 'Loading...' : 'Load Telemetry'}
            </button>
          </div>

        </div>
      </div>

      {loadingLaps && <div className="state-loading">Loading laps...</div>}
      {error && <div className="state-error">{error}</div>}

      {/* Info Bar */}
      {(tel1 || tel2) && (
        <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-4)', flexShrink: 0 }}>
          {renderLapInfo(activeLap1, tel1, driverColours.color1, 'Trace 1')}
          {renderLapInfo(activeLap2, tel2, driverColours.color2, 'Trace 2')}
        </div>
      )}

      {/* Charts */}
      <div 
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--surface-primary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverX(null)}
      >
        {(tel1 || tel2) ? activeArr.map(ch => {
          const cfg = CHANNEL_CONFIG[ch];
          return (
            <div key={ch} style={{ position: 'relative', height: svgH }}>
              <div style={{ position: 'absolute', top: 5, left: padL + 5, fontSize: 11, fontWeight: 600, color: cfg.colour }}>
                {cfg.label} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>({cfg.unit})</span>
              </div>
              <svg width={chartW} height={svgH} style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                {/* Grid */}
                {Array.from({ length: 5 }, (_, i) => padT + (plotH * i) / 4).map((y, i) => (
                  <line key={i} x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border-default)" strokeDasharray="4,4" />
                ))}
                
                {/* Corner Markers */}
                {circuit.map(corner => {
                  if (!corner.distance || corner.distance > maxDist) return null;
                  const cx = padL + (corner.distance / maxDist) * plotW;
                  return (
                    <g key={`corner-${corner.number}`}>
                      <line x1={cx} y1={padT} x2={cx} y2={padT + plotH} stroke="var(--border-default)" strokeDasharray="2,2" strokeOpacity={0.4} />
                      <text x={cx} y={padT - 4} fill="var(--text-tertiary)" fontSize={9} textAnchor="middle">{corner.number}</text>
                    </g>
                  );
                })}

                {/* Traces */}
                {ch === 'delta' && deltaTrace ? (
                  <g>
                    <line x1={padL} y1={padT + plotH - ((0 - deltaTrace.min) / (deltaTrace.max - deltaTrace.min)) * plotH} x2={padL + plotW} y2={padT + plotH - ((0 - deltaTrace.min) / (deltaTrace.max - deltaTrace.min)) * plotH} stroke="var(--text-tertiary)" strokeDasharray="2,2" />
                    <polyline
                      points={deltaTrace.points.map(p => {
                        const x = padL + ((p.distance / maxDist) * plotW);
                        const val = Math.min(Math.max(p.delta, deltaTrace.min), deltaTrace.max);
                        const y = padT + plotH - ((val - deltaTrace.min) / (deltaTrace.max - deltaTrace.min)) * plotH;
                        return `${x},${y}`;
                      }).join(' ')}
                      fill="none"
                      stroke="var(--text-primary)"
                      strokeWidth={1.5}
                      opacity={0.85}
                    />
                  </g>
                ) : (
                  <g>
                    {renderTraceForChannel(tel1, driverColours.color1, ch)}
                    {renderTraceForChannel(tel2, driverColours.color2, ch)}
                  </g>
                )}
                
                {/* Y-axis labels */}
                <text x={padL - 8} y={padT + 4} fill="var(--text-tertiary)" fontSize={10} textAnchor="end" alignmentBaseline="middle">{ch === 'delta' && deltaTrace ? deltaTrace.max.toFixed(2) : cfg.max}</text>
                <text x={padL - 8} y={padT + plotH + 4} fill="var(--text-tertiary)" fontSize={10} textAnchor="end" alignmentBaseline="middle">{ch === 'delta' && deltaTrace ? deltaTrace.min.toFixed(2) : cfg.min}</text>

                {/* Hover Crosshair */}
                {hoverX !== null && (
                  <line x1={hoverX} y1={padT} x2={hoverX} y2={padT + plotH} stroke="var(--accent-teal)" strokeWidth={1} opacity={0.5} />
                )}
              </svg>
            </div>
          );
        }) : (
          !loadingTel && <div className="state-empty" style={{ height: '100%' }}>Select traces and load telemetry to begin analysis</div>
        )}

        {/* Hover Tooltip */}
        {hoverX !== null && (tel1 || tel2) && (
          <div style={{
            position: 'absolute', 
            left: hoverX + 15 > chartW - 150 ? hoverX - 160 : hoverX + 15, 
            top: 20,
            background: 'var(--bg-elevated)', border: '1px solid var(--border-emphasis)',
            borderRadius: '6px', padding: '10px', fontSize: '11px', pointerEvents: 'none',
            zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: '120px',
            fontFamily: 'var(--font-mono)'
          }}>
            <div style={{ color: 'var(--text-tertiary)', marginBottom: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '4px' }}>
              DIST: {Math.round((hoverX - padL) / plotW * maxDist)}m
            </div>
            {tel1 && hoverPt1 && (
              <div style={{ color: driverColours.color1, marginBottom: tel2 ? '8px' : '0' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>{tel1.driver} (L{activeLap1?.lap_number})</div>
                {activeArr.filter(c => c !== 'delta').map(ch => (
                  <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                    <span>{ch.toUpperCase()}:</span>
                    <span>{hoverPt1[ch]}{CHANNEL_CONFIG[ch].unit}</span>
                  </div>
                ))}
              </div>
            )}
            {tel2 && hoverPt2 && (
              <div style={{ color: driverColours.color2, paddingTop: '8px', borderTop: tel1 ? '1px solid var(--border-default)' : 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>{tel2.driver} (L{activeLap2?.lap_number})</div>
                {activeArr.filter(c => c !== 'delta').map(ch => (
                  <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                    <span>{ch.toUpperCase()}:</span>
                    <span>{hoverPt2[ch]}{CHANNEL_CONFIG[ch].unit}</span>
                  </div>
                ))}
              </div>
            )}
            {deltaTrace && activeArr.includes('delta') && hoverDelta && (
              <div style={{ color: 'var(--text-primary)', paddingTop: '8px', borderTop: tel1 ? '1px solid var(--border-default)' : 'none' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>Time Delta (T2 - T1)</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <span>DELTA:</span>
                  <span style={{ color: hoverDelta.delta > 0 ? 'var(--accent-red)' : 'var(--accent-teal)', fontWeight: 600 }}>
                    {hoverDelta.delta > 0 ? '+' : ''}{hoverDelta.delta.toFixed(3)}s
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TelemetryPage;
