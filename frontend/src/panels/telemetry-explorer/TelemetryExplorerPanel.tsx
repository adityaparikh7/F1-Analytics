import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { TelemetryResponse, LapData, CornerData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour, adjustColorLightness, DRIVER_TEAMS } from '../../lib/colours';

const CircularProgress: React.FC<{ value: number; color: string; label: string; size?: number; strokeWidth?: number }> = ({ value, color, label, size = 50, strokeWidth = 5 }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;
  
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', overflow: 'visible' }}>
          <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="var(--border-default)" strokeWidth={strokeWidth} />
          <circle 
            cx={size/2} 
            cy={size/2} 
            r={radius} 
            fill="none" 
            stroke={color} 
            strokeWidth={strokeWidth} 
            strokeDasharray={circumference} 
            strokeDashoffset={offset} 
            strokeLinecap="round" 
            style={{ transition: 'stroke-dashoffset 1s ease-out', filter: `drop-shadow(0 0 4px ${color}80)` }} 
          />
        </svg>
        <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{Math.round(value)}%</span>
        </div>
      </div>
      <span style={{ fontSize: '9px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </div>
  );
};

const PaceStylePanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const navigate = useNavigate();
  const [tel1, setTel1] = useState<TelemetryResponse | null>(null);
  const [tel2, setTel2] = useState<TelemetryResponse | null>(null);
  const [lap1, setLap1] = useState<LapData | null>(null);
  const [lap2, setLap2] = useState<LapData | null>(null);
  const [circuit, setCircuit] = useState<CornerData[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const circuitPromise = api.getCircuitInfo(sessionKey).catch(() => []);
        const resultsPromise = api.getResults(sessionKey);
        
        const [circuitData, results] = await Promise.all([circuitPromise, resultsPromise]);
        if (!isMounted) return;
        setCircuit(circuitData);

        if (results.length >= 2) {
          const sorted = results.sort((a, b) => {
            if (a.position !== null && b.position !== null) return a.position - b.position;
            return (a.best_lap_time || 9999) - (b.best_lap_time || 9999);
          });
          const d1 = sorted[0].driver;
          const d2 = sorted[1].driver;

          const [t1, l1, t2, l2] = await Promise.all([
            api.getTelemetry(sessionKey, d1, 'fastest', 4),
            api.getLaps(sessionKey, { driver: d1 }),
            api.getTelemetry(sessionKey, d2, 'fastest', 4),
            api.getLaps(sessionKey, { driver: d2 })
          ]);
          
          if (!isMounted) return;
          setTel1(t1);
          setTel2(t2);
          
          const best1 = l1.length ? l1.reduce((a, b) => ((a.lap_time||9999) < (b.lap_time||9999) ? a : b)) : null;
          setLap1(best1);
          
          const best2 = l2.length ? l2.reduce((a, b) => ((a.lap_time||9999) < (b.lap_time||9999) ? a : b)) : null;
          setLap2(best2);
        }
      } catch (err: any) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchData();

    return () => { isMounted = false; };
  }, [sessionKey]);

  const driverColours = useMemo(() => {
    const defaultC1 = tel1 ? getDriverColour(tel1.driver, lap1?.team) : '#ff0000';
    const defaultC2 = tel2 ? getDriverColour(tel2.driver, lap2?.team) : '#00d5ff';

    if (!tel1 || !tel2) return { color1: defaultC1, color2: defaultC2 };

    const team1 = lap1?.team || DRIVER_TEAMS[tel1.driver];
    const team2 = lap2?.team || DRIVER_TEAMS[tel2.driver];

    if ((team1 && team2 && team1 === team2) || defaultC1 === defaultC2) {
      return { color1: defaultC1, color2: adjustColorLightness(defaultC2, 25) };
    }

    return { color1: defaultC1, color2: defaultC2 };
  }, [tel1, tel2, lap1, lap2]);

  const getDrivingStyle = (tel: TelemetryResponse | null) => {
    if (!tel || !tel.data.length) return { fullThrottle: 0, braking: 0, coasting: 0 };
    let throttleCount = 0;
    let brakeCount = 0;
    let total = 0;
    for (const pt of tel.data) {
      if (pt.throttle == null || pt.brake == null) continue;
      total++;
      if (pt.throttle >= 95) throttleCount++;
      if (pt.brake >= 5) brakeCount++;
    }
    if (total === 0) return { fullThrottle: 0, braking: 0, coasting: 0 };
    
    const ft = (throttleCount / total) * 100;
    const br = (brakeCount / total) * 100;
    const coast = Math.max(0, 100 - ft - br);
    return { fullThrottle: ft, braking: br, coasting: coast };
  };

  const style1 = useMemo(() => getDrivingStyle(tel1), [tel1]);
  const style2 = useMemo(() => getDrivingStyle(tel2), [tel2]);

  const cornerApexes = useMemo(() => {
    if (!tel1 || !tel2 || !circuit.length) return [];
    
    const getCornerApex = (tel: TelemetryResponse, cornerDist: number) => {
      const searchRange = 150;
      const points = tel.data.filter(p => p.distance != null && Math.abs(p.distance - cornerDist) < searchRange && p.speed != null);
      if (points.length === 0) return null;
      return Math.min(...points.map(p => p.speed as number));
    };

    const cornerSpeeds = circuit.map(c => {
      if (c.distance == null) return null;
      const s1 = getCornerApex(tel1, c.distance);
      const s2 = getCornerApex(tel2, c.distance);
      if (s1 == null || s2 == null) return null;
      return { number: c.number, s1, s2, avg: (s1 + s2) / 2 };
    }).filter(Boolean) as { number: number, s1: number, s2: number, avg: number, label?: string }[];

    if (cornerSpeeds.length < 3) return cornerSpeeds;
    cornerSpeeds.sort((a, b) => a.avg - b.avg);
    
    const slowest = cornerSpeeds[0];
    const fastest = cornerSpeeds[cornerSpeeds.length - 1];
    const median = cornerSpeeds[Math.floor(cornerSpeeds.length / 2)];
    
    const selected = new Map();
    selected.set(slowest.number, { ...slowest, label: 'Slowest' });
    if (!selected.has(median.number)) selected.set(median.number, { ...median, label: 'Medium' });
    if (!selected.has(fastest.number)) selected.set(fastest.number, { ...fastest, label: 'Fastest' });
    
    return Array.from(selected.values()).sort((a, b) => a.number - b.number);
  }, [tel1, tel2, circuit]);

  if (!sessionKey) return <div className="state-empty">Select a session to view summary</div>;
  if (loading) return <div className="state-loading">Loading telemetry data...</div>;
  if (error) return <div className="state-error" style={{ fontSize: 'var(--fs-sm)' }}>{error}</div>;
  if (!tel1 || !tel2) return <div className="state-empty">Not enough data</div>;

  const maxCornerSpeed = cornerApexes.length ? Math.max(...cornerApexes.flatMap(c => [c.s1, c.s2])) : 300;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', background: 'var(--bg-default)', padding: 'var(--space-2)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: driverColours.color1, boxShadow: `0 0 8px ${driverColours.color1}` }} />
            <span style={{ fontWeight: 700, fontSize: 'var(--fs-md)' }}>{tel1.driver}</span>
          </div>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-xs)', fontStyle: 'italic' }}>VS</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: driverColours.color2, boxShadow: `0 0 8px ${driverColours.color2}` }} />
            <span style={{ fontWeight: 700, fontSize: 'var(--fs-md)' }}>{tel2.driver}</span>
          </div>
        </div>
        <button 
          className="btn btn--outline" 
          style={{ fontSize: 'var(--fs-xs)', padding: '4px 10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
          onClick={() => navigate('/telemetry')}
          title="Open Full Page Analysis"
        >
          ⤢ Full Telemetry
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
        {/* Driving Style Section */}
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.03)', 
          backdropFilter: 'blur(10px)', 
          border: '1px solid rgba(255, 255, 255, 0.05)', 
          borderRadius: 'var(--radius-lg)', 
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Driving Style (Throttle & Brake)
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
            {/* Driver 1 Style */}
            <div style={{ display: 'flex', gap: '16px' }}>
              <CircularProgress value={style1.fullThrottle} color={driverColours.color1} label="Throttle" />
              <CircularProgress value={style1.braking} color={driverColours.color1} label="Brake" />
            </div>

            <div style={{ height: '40px', width: '1px', background: 'var(--border-subtle)' }} />

            {/* Driver 2 Style */}
            <div style={{ display: 'flex', gap: '16px' }}>
              <CircularProgress value={style2.fullThrottle} color={driverColours.color2} label="Throttle" />
              <CircularProgress value={style2.braking} color={driverColours.color2} label="Brake" />
            </div>
          </div>
        </div>

        {/* Corner Apex Speeds Section */}
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.03)', 
          backdropFilter: 'blur(10px)', 
          border: '1px solid rgba(255, 255, 255, 0.05)', 
          borderRadius: 'var(--radius-lg)', 
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          flex: 1
        }}>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Corner Apex Speeds
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, justifyContent: 'center' }}>
            {cornerApexes.map(corner => (
              <div key={corner.number} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>Turn {corner.number} <span style={{ opacity: 0.6 }}>({corner.label})</span></span>
                </div>
                
                <div style={{ position: 'relative', height: '24px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {/* Driver 1 Bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ 
                      height: '10px', 
                      width: `${(corner.s1 / maxCornerSpeed) * 85}%`, 
                      background: `linear-gradient(90deg, transparent, ${driverColours.color1})`,
                      borderRadius: '0 4px 4px 0',
                      transition: 'width 1s ease-out'
                    }} />
                    <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: driverColours.color1, fontWeight: 600 }}>
                      {Math.round(corner.s1)}
                    </span>
                  </div>
                  
                  {/* Driver 2 Bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ 
                      height: '10px', 
                      width: `${(corner.s2 / maxCornerSpeed) * 85}%`, 
                      background: `linear-gradient(90deg, transparent, ${driverColours.color2})`,
                      borderRadius: '0 4px 4px 0',
                      transition: 'width 1s ease-out'
                    }} />
                    <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: driverColours.color2, fontWeight: 600 }}>
                      {Math.round(corner.s2)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            
            {cornerApexes.length === 0 && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                No corner marker data available for this circuit.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

registerPanel({ id: 'telemetry-explorer', title: 'Telemetry Analysis', category: 'telemetry', Component: PaceStylePanel });
export default PaceStylePanel;
