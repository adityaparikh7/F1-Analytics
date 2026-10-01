import { useEffect, useState, useMemo } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { api } from '../lib/api';
import type { CarPerformanceResponse } from '../lib/api';
import { getDriverColour, getTeamColour } from '../lib/colours';
import { formatSessionType } from '../lib/format';
import { logger } from '../lib/logger';

export default function CarPerformancePage() {
  const { activeSessionKey, sessions } = useSessionStore();
  const [data, setData] = useState<CarPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type SortColumn = 'position' | 'driver' | 'team' | 'top_speed' | 'mean_speed' | 'full_throttle' | 'braking' | 'coasting' | 's1' | 's2' | 's3' | 'avgCornerSpeed';
  const [sortCol, setSortCol] = useState<SortColumn>('position');
  const [sortAsc, setSortAsc] = useState(true);

  const session = sessions.find(s => s.session_key === activeSessionKey);

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      if (!activeSessionKey) return;
      setLoading(true);
      setError(null);

      try {
        const response = await api.getCarPerformance(activeSessionKey);
        if (mounted) setData(response);
      } catch (err) {
        logger.error('Failed to load car performance data:', err);
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadData();
    return () => { mounted = false; };
  }, [activeSessionKey]);

  const driversWithAvgCorner = useMemo(() => {
    if (!data) return [];
    return data.drivers.map(d => {
      const valid = d.corner_speeds.filter(c => c.apex_speed !== null);
      const avg = valid.length > 0
        ? valid.reduce((sum, c) => sum + (c.apex_speed || 0), 0) / valid.length
        : 0;
      return { ...d, avgCornerSpeed: avg };
    });
  }, [data]);

  const sortedTableData = useMemo(() => {
    if (!driversWithAvgCorner) return [];

    return [...driversWithAvgCorner].sort((a, b) => {
      const getValue = (d: typeof a): number | string | null => {
        switch (sortCol) {
          case 'position': return d.position;
          case 'driver': return d.driver;
          case 'team': return d.team;
          case 'top_speed': return d.aero.top_speed;
          case 'mean_speed': return d.aero.mean_speed;
          case 'full_throttle': return d.driving_style.full_throttle;
          case 'braking': return d.driving_style.braking;
          case 'coasting': return d.driving_style.coasting;
          case 's1': return d.sectors.s1;
          case 's2': return d.sectors.s2;
          case 's3': return d.sectors.s3;
          case 'avgCornerSpeed': return d.avgCornerSpeed;
          default: return null;
        }
      };
      const valA = getValue(a);
      const valB = getValue(b);

      if (valA === null) return 1;
      if (valB === null) return -1;

      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [driversWithAvgCorner, sortCol, sortAsc]);

  const handleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  // --- Guard states matching RacePacePage patterns ---

  if (!activeSessionKey) {
    return (
      <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <h2 style={{ marginBottom: 'var(--space-4)' }}>No Session Selected</h2>
      </div>
    );
  }

  if (loading && !data) {
    return <div className="state-loading">Analyzing car performance…</div>;
  }

  if (error) {
    return <div className="state-error">{error}</div>;
  }

  if (!data || data.drivers.length === 0) {
    return <div className="state-empty">No performance data available for this session.</div>;
  }

  // --- Derived data ---

  const driversSortedByThrottle = [...data.drivers].sort((a, b) => b.driving_style.full_throttle - a.driving_style.full_throttle);

  const heatmapColorScale = (speed: number, minSpeed: number, maxSpeed: number, alpha = 0.7) => {
    if (speed === 0 || minSpeed === maxSpeed) return 'transparent';
    const t = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));
    let r: number, g: number, b: number;
    if (t < 0.25) {
      const s = t / 0.25;
      r = Math.round(26 + (139 - 26) * s);
      g = Math.round(26 + (0 - 26) * s);
      b = Math.round(46 + (0 - 46) * s);
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      r = Math.round(139 + (255 - 139) * s);
      g = Math.round(0 + (69 - 0) * s);
      b = Math.round(0);
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      r = 255;
      g = Math.round(69 + (215 - 69) * s);
      b = Math.round(0);
    } else {
      const s = (t - 0.75) / 0.25;
      r = 255;
      g = Math.round(215 + (255 - 215) * s);
      b = Math.round(0 + 255 * s);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  let minCornerSpeed = Infinity;
  let maxCornerSpeed = -Infinity;
  data.drivers.forEach(d => {
    d.corner_speeds.forEach(c => {
      if (c.apex_speed !== null) {
        if (c.apex_speed < minCornerSpeed) minCornerSpeed = c.apex_speed;
        if (c.apex_speed > maxCornerSpeed) maxCornerSpeed = c.apex_speed;
      }
    });
  });

  const driversSortedByAvgCorner = [...driversWithAvgCorner].sort((a, b) => b.avgCornerSpeed - a.avgCornerSpeed);
  const driversSortedByTopSpeed = [...data.drivers].sort((a, b) => b.aero.top_speed - a.aero.top_speed);

  const getSectorDeltaColor = (delta: number) => {
    if (delta < 0.2) return 'var(--accent-teal)';
    if (delta <= 0.5) return 'var(--accent-amber)';
    return 'var(--accent-red)';
  };

  const getDeltaText = (val: number | null, best: number | null) => {
    if (val === null || best === null) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    const delta = val - best;
    const sign = delta > 0 ? '+' : '';
    const color = delta <= 0 ? 'var(--accent-teal)' : 'var(--accent-red)';
    return <span style={{ color }}>{sign}{delta.toFixed(3)}</span>;
  };

  // Section card shared style
  const sectionStyle = {
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.05)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-4)',
  } as const;

  const sectionHeadingStyle = {
    fontSize: 'var(--fs-sm)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    margin: '0 0 var(--space-4) 0',
  };

  // Column header labels
  const colLabels: Record<string, string> = {
    position: 'Pos', driver: 'Driver', team: 'Team',
    top_speed: 'Top Spd', mean_speed: 'Mean Spd',
    full_throttle: 'Throttle %', braking: 'Brake %', coasting: 'Coast %',
    s1: 'S1 Δ', s2: 'S2 Δ', s3: 'S3 Δ',
  };

  return (
    <div style={{ padding: 'var(--space-6)', overflowY: 'auto', height: '100%', width: '100%' }}>
      {/* Header — matches RacePacePage */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-6)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Car Performance Analysis
          </h1>
          <p style={{ color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
            {session?.event_name} {session?.year} — {formatSessionType(session?.session_type ?? '')}
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-8)' }}>

        {/* Section 1: Performance Overview Table */}
        <section style={{ ...sectionStyle, overflowX: 'auto' }}>
          <h3 style={sectionHeadingStyle}>Performance Overview</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 'var(--fs-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                {Object.entries(colLabels).map(([col, label]) => (
                  <th
                    key={col}
                    style={{ padding: 'var(--space-2)', cursor: 'pointer', userSelect: 'none', fontWeight: 600, fontSize: 'var(--fs-xs)' }}
                    onClick={() => handleSort(col as SortColumn)}
                  >
                    {label}{sortCol === col && (sortAsc ? ' ↑' : ' ↓')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedTableData.map(d => (
                <tr key={d.driver} style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <td style={{ padding: 'var(--space-2)', borderLeft: `3px solid ${getTeamColour(d.team)}` }}>{d.position || '—'}</td>
                  <td style={{ padding: 'var(--space-2)', fontWeight: 600, color: getDriverColour(d.driver, d.team) }}>{d.driver}</td>
                  <td style={{ padding: 'var(--space-2)', color: 'var(--text-secondary)' }}>{d.team}</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{d.aero.top_speed.toFixed(1)}</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{d.aero.mean_speed.toFixed(1)}</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{d.driving_style.full_throttle.toFixed(1)}%</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{d.driving_style.braking.toFixed(1)}%</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{d.driving_style.coasting.toFixed(1)}%</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{getDeltaText(d.sectors.s1, data.best_sectors.s1)}</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{getDeltaText(d.sectors.s2, data.best_sectors.s2)}</td>
                  <td style={{ padding: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>{getDeltaText(d.sectors.s3, data.best_sectors.s3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Section 2: Driving Style Comparison */}
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Driving Style Comparison</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {driversSortedByThrottle.map(d => (
              <div key={d.driver} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', width: '60px', gap: '6px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: getTeamColour(d.team) }} />
                  <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{d.driver}</span>
                </div>
                <div style={{
                  flex: 1,
                  height: '24px',
                  display: 'flex',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  fontSize: 'var(--fs-xs)',
                  fontFamily: 'var(--font-mono)',
                  color: 'white',
                  fontWeight: 600,
                  textAlign: 'center',
                  lineHeight: '24px',
                }}>
                  {d.driving_style.full_throttle > 0 && (
                    <div style={{ width: `${d.driving_style.full_throttle}%`, backgroundColor: 'var(--accent-teal)' }}>
                      {d.driving_style.full_throttle.toFixed(1)}%
                    </div>
                  )}
                  {d.driving_style.coasting > 0 && (
                    <div style={{ width: `${d.driving_style.coasting}%`, backgroundColor: 'var(--text-tertiary)' }}>
                      {d.driving_style.coasting.toFixed(1)}%
                    </div>
                  )}
                  {d.driving_style.braking > 0 && (
                    <div style={{ width: `${d.driving_style.braking}%`, backgroundColor: 'var(--accent-red)' }}>
                      {d.driving_style.braking.toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Section 3: Corner Speed Heatmap */}
        <section style={{ ...sectionStyle, overflowX: 'auto' }}>
          <h3 style={sectionHeadingStyle}>Corner Speed Heatmap (km/h)</h3>
          <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, top: 0, backgroundColor: 'var(--bg-panel)', zIndex: 2, padding: 'var(--space-2)', textAlign: 'left', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' }}>Driver</th>
                {data.corners.map(c => (
                  <th key={c.number} style={{ padding: 'var(--space-2)', position: 'sticky', top: 0, backgroundColor: 'var(--bg-panel)', zIndex: 1, minWidth: '42px', textAlign: 'center', color: 'var(--text-tertiary)', fontWeight: 400, borderBottom: '1px solid var(--border-default)' }}>
                    T{c.number}
                  </th>
                ))}
                <th style={{ position: 'sticky', right: 0, top: 0, backgroundColor: 'var(--bg-panel)', zIndex: 2, padding: 'var(--space-2)', textAlign: 'center', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)', borderLeft: '2px solid var(--border-emphasis)' }}>AVG</th>
              </tr>
            </thead>
            <tbody>
              {driversSortedByAvgCorner.map(d => (
                <tr key={d.driver}>
                  <td style={{ position: 'sticky', left: 0, backgroundColor: 'var(--bg-panel)', padding: 'var(--space-2)', fontWeight: 600, borderRight: '1px solid var(--border-default)', borderBottom: '1px solid var(--border-default)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: getTeamColour(d.team) }} />
                      {d.driver}
                    </div>
                  </td>
                  {data.corners.map(c => {
                    const cornerData = d.corner_speeds.find(cs => cs.corner === c.number);
                    const speed = cornerData?.apex_speed;
                    return (
                      <td key={c.number} style={{
                        padding: 'var(--space-2)',
                        textAlign: 'center',
                        backgroundColor: speed ? heatmapColorScale(speed, minCornerSpeed, maxCornerSpeed) : 'transparent',
                        color: speed ? 'var(--text-primary)' : 'var(--text-tertiary)',
                        borderBottom: '1px solid var(--border-default)',
                      }}>
                        {speed ? speed.toFixed(1) : '—'}
                      </td>
                    );
                  })}
                  <td style={{
                    position: 'sticky',
                    right: 0,
                    backgroundColor: 'var(--bg-raised)',
                    padding: 'var(--space-2)',
                    textAlign: 'center',
                    borderLeft: '2px solid var(--border-emphasis)',
                    borderBottom: '1px solid var(--border-default)',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                  }}>
                    {d.avgCornerSpeed.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Section 4 & 5: Side-by-side grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-6)' }}>

          {/* Section 4: Top Speeds */}
          <section style={sectionStyle}>
            <h3 style={sectionHeadingStyle}>Top Speeds</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {driversSortedByTopSpeed.map(d => {
                const maxSpeed = driversSortedByTopSpeed[0].aero.top_speed;
                const widthPct = (d.aero.top_speed / maxSpeed) * 100;
                return (
                  <div key={d.driver} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', width: '44px', gap: '4px', flexShrink: 0 }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: getTeamColour(d.team) }} />
                      <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>{d.driver}</span>
                    </div>
                    <div style={{ flex: 1, height: '14px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                      <div style={{ width: `${widthPct}%`, height: '100%', background: `linear-gradient(90deg, transparent, ${getTeamColour(d.team)})`, borderRadius: '0 var(--radius-sm) var(--radius-sm) 0', transition: 'width 1s ease-out' }} />
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', width: '46px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                      {d.aero.top_speed.toFixed(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Section 5: Aero Efficiency Quadrant */}
          <section style={sectionStyle}>
            <h3 style={sectionHeadingStyle}>Aero Efficiency Quadrant</h3>
            <div style={{ position: 'relative', width: '100%', aspectRatio: '1', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {/* Quadrant zone backgrounds */}
              <div style={{ position: 'absolute', top: 0, right: 0, width: '50%', height: '50%', backgroundColor: 'rgba(0, 210, 190, 0.04)' }} />
              <div style={{ position: 'absolute', top: 0, left: 0, width: '50%', height: '50%', backgroundColor: 'rgba(54, 113, 198, 0.04)' }} />
              <div style={{ position: 'absolute', bottom: 0, right: 0, width: '50%', height: '50%', backgroundColor: 'rgba(232, 0, 45, 0.04)' }} />
              <div style={{ position: 'absolute', bottom: 0, left: 0, width: '50%', height: '50%', backgroundColor: 'rgba(255, 201, 6, 0.04)' }} />

              {/* Crosshairs */}
              <div style={{ position: 'absolute', top: '50%', left: 0, width: '100%', height: '1px', borderTop: '1px dashed var(--border-emphasis)' }} />
              <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', borderLeft: '1px dashed var(--border-emphasis)' }} />

              {/* Driver dots */}
              {(() => {
                const meanSpeeds = data.drivers.map(dr => dr.aero.mean_speed);
                const topSpeeds = data.drivers.map(dr => dr.aero.top_speed);
                const meanMin = Math.min(...meanSpeeds);
                const meanMax = Math.max(...meanSpeeds);
                const topMin = Math.min(...topSpeeds);
                const topMax = Math.max(...topSpeeds);
                const pad = 0.1;
                const meanRange = (meanMax - meanMin) || 1;
                const topRange = (topMax - topMin) || 1;

                return data.drivers.map(d => {
                  const xPct = pad * 100 + ((d.aero.mean_speed - meanMin) / meanRange) * (1 - 2 * pad) * 100;
                  const yPct = (1 - pad) * 100 - ((d.aero.top_speed - topMin) / topRange) * (1 - 2 * pad) * 100;
                  return (
                    <div key={d.driver} style={{
                      position: 'absolute',
                      left: `${xPct}%`,
                      top: `${yPct}%`,
                      transform: 'translate(-50%, -50%)',
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      backgroundColor: getTeamColour(d.team),
                      boxShadow: `0 0 8px ${getTeamColour(d.team)}`,
                      cursor: 'pointer',
                    }} title={`${d.driver}: Mean ${d.aero.mean_speed.toFixed(1)}, Top ${d.aero.top_speed.toFixed(1)}`} />
                  );
                });
              })()}

              {/* Quadrant labels */}
              <div style={{ position: 'absolute', top: 'var(--space-2)', right: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>High Efficiency</div>
              <div style={{ position: 'absolute', top: 'var(--space-2)', left: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>Low Downforce</div>
              <div style={{ position: 'absolute', bottom: 'var(--space-2)', right: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>High Downforce</div>
              <div style={{ position: 'absolute', bottom: 'var(--space-2)', left: 'var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>Low Efficiency</div>
            </div>
            <div style={{ textAlign: 'center', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', marginTop: 'var(--space-2)' }}>
              X = Mean Speed &nbsp;·&nbsp; Y = Top Speed
            </div>
          </section>
        </div>

        {/* Section 6: Sector Performance Deltas */}
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Sector Performance Deltas</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-6)' }}>
            {[
              { id: 's1', name: 'Sector 1' },
              { id: 's2', name: 'Sector 2' },
              { id: 's3', name: 'Sector 3' },
            ].map(sector => (
              <div key={sector.id}>
                <h4 style={{ margin: '0 0 var(--space-3) 0', fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', fontWeight: 600 }}>{sector.name}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {data.drivers
                    .filter(d => d.sectors[sector.id as keyof typeof d.sectors] !== null)
                    .sort((a, b) => (a.sectors[sector.id as keyof typeof a.sectors] as number) - (b.sectors[sector.id as keyof typeof b.sectors] as number))
                    .map(d => {
                      const sectorTime = d.sectors[sector.id as keyof typeof d.sectors] as number;
                      const bestTime = data.best_sectors[sector.id as keyof typeof data.best_sectors] as number;
                      const delta = sectorTime - bestTime;
                      const widthPct = Math.min(100, Math.max(2, (delta / 1.5) * 100));

                      return (
                        <div key={d.driver} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: getTeamColour(d.team), flexShrink: 0 }} />
                          <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)', width: '30px', flexShrink: 0 }}>{d.driver}</span>
                          <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                            <div style={{
                              height: '10px',
                              width: delta <= 0 ? '2px' : `${widthPct}%`,
                              background: delta <= 0
                                ? 'var(--accent-teal)'
                                : `linear-gradient(90deg, transparent, ${getSectorDeltaColor(delta)})`,
                              borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                              transition: 'width var(--transition-slow)',
                            }} />
                          </div>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', width: '50px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {delta <= 0 ? 'Best' : `+${delta.toFixed(3)}`}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
