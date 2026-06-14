import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import _Plot from 'react-plotly.js';
const Plot = (_Plot as any).default || _Plot;
import { api } from '../lib/api';
import type { LapData, ResultData } from '../lib/api';
import { useSessionStore } from '../store/sessionStore';
import { getDriverColour, getTeamColour } from '../lib/colours';
import { formatLapTime, formatCompound, getPaceRating, getProperLapThreshold } from '../lib/format';

interface DriverStat {
  driver: string;
  team: string | null;
  laps: LapData[];
  mean: number;
  fastestLapTime: number | null;
  fastestLapCompound: string | null;
}

interface TeamStat {
  team: string;
  laps: LapData[];
  mean: number;
  fastestLapTime: number | null;
  fastestLapCompound: string | null;
}

const compoundColors: Record<string, string> = {
  SOFT: '#FF3333',
  MEDIUM: '#FFD700',
  HARD: '#FFFFFF',
  INTERMEDIATE: '#3CB371',
  WET: '#1E90FF',
  UNKNOWN: '#888888',
};

const RacePacePage: React.FC = () => {
  const navigate = useNavigate();
  const { activeSessionKey, sessions } = useSessionStore();
  const session = sessions.find(s => s.session_key === activeSessionKey);

  const [laps, setLaps] = useState<LapData[]>([]);
  const [results, setResults] = useState<ResultData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterProper, setFilterProper] = useState(true);
  const [filterFinishers, setFilterFinishers] = useState(false);

  useEffect(() => {
    if (!activeSessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);

    Promise.all([
      api.getLaps(activeSessionKey, { exclude_pit_laps: false }),
      api.getResults(activeSessionKey).catch(() => [] as ResultData[])
    ])
      .then(([lapData, resultData]) => {
        if (!isMounted) return;
        setLaps(lapData);
        setResults(resultData);
        setLoading(false);
      })
      .catch(err => {
        if (!isMounted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => { isMounted = false; };
  }, [activeSessionKey]);

  // Compute filtered laps
  const { filteredLaps, driverStats, teamStats, driverFastest, teamFastest } = useMemo(() => {
    if (!laps.length) return { filteredLaps: [], driverStats: [], teamStats: [], driverFastest: 0, teamFastest: 0 };

    let fastestLap = Infinity;
    for (const lap of laps) {
      if (lap.lap_time && lap.lap_time > 0 && lap.lap_time < fastestLap) {
        fastestLap = lap.lap_time;
      }
    }

    const threshold107 = getProperLapThreshold(fastestLap);

    const finishingDrivers = new Set<string>();
    if (filterFinishers) {
      for (const r of results) {
        if (r.status === 'Finished' || r.status === 'Lapped' || r.status?.includes('+')) {
          finishingDrivers.add(r.driver);
        }
      }
    }

    const validLaps = laps.filter(lap => {
      if (lap.lap_time == null || lap.lap_time <= 0) return false;
      
      if (filterProper) {
        if (lap.is_pit_in_lap || lap.is_pit_out_lap) return false;
        if (lap.lap_time > threshold107) return false;
      }
      
      if (filterFinishers && !finishingDrivers.has(lap.driver)) {
        return false;
      }

      return true;
    });

    const driverMap = new Map<string, { team: string | null; laps: LapData[] }>();
    const teamMap = new Map<string, LapData[]>();

    for (const lap of validLaps) {
      if (!driverMap.has(lap.driver)) driverMap.set(lap.driver, { team: lap.team, laps: [] });
      driverMap.get(lap.driver)!.laps.push(lap);

      if (lap.team) {
        if (!teamMap.has(lap.team)) teamMap.set(lap.team, []);
        teamMap.get(lap.team)!.push(lap);
      }
    }

    const driverStats: DriverStat[] = Array.from(driverMap.entries())
      .map(([driver, { team, laps }]) => {
        const sum = laps.reduce((acc, l) => acc + (l.lap_time || 0), 0);
        let fastestLap: LapData | null = null;
        for (const lap of laps) {
          if (lap.lap_time && lap.lap_time > 0) {
            if (!fastestLap || fastestLap.lap_time === null || lap.lap_time < fastestLap.lap_time) {
              fastestLap = lap;
            }
          }
        }
        return {
          driver,
          team,
          laps,
          mean: sum / laps.length,
          fastestLapTime: fastestLap ? fastestLap.lap_time : null,
          fastestLapCompound: fastestLap ? fastestLap.compound : null,
        };
      })
      .sort((a, b) => a.mean - b.mean);

    const teamStats: TeamStat[] = Array.from(teamMap.entries())
      .map(([team, laps]) => {
        const sum = laps.reduce((acc, l) => acc + (l.lap_time || 0), 0);
        let fastestLap: LapData | null = null;
        for (const lap of laps) {
          if (lap.lap_time && lap.lap_time > 0) {
            if (!fastestLap || fastestLap.lap_time === null || lap.lap_time < fastestLap.lap_time) {
              fastestLap = lap;
            }
          }
        }
        return {
          team,
          laps,
          mean: sum / laps.length,
          fastestLapTime: fastestLap ? fastestLap.lap_time : null,
          fastestLapCompound: fastestLap ? fastestLap.compound : null,
        };
      })
      .sort((a, b) => a.mean - b.mean);

    const driverFastest = driverStats.length > 0 ? driverStats[0].mean : 0;
    const teamFastest = teamStats.length > 0 ? teamStats[0].mean : 0;

    return { filteredLaps: validLaps, driverStats, teamStats, driverFastest, teamFastest };
  }, [laps, results, filterProper, filterFinishers]);

  if (!activeSessionKey) {
    return (
      <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <h2 style={{ marginBottom: 'var(--space-4)' }}>No Session Selected</h2>
        <button className="btn btn--primary" onClick={() => navigate('/')}>Return to Dashboard</button>
      </div>
    );
  }

  // Generate Plotly Data for Drivers
  const driverBoxTraces: Plotly.Data[] = driverStats.map(stat => {
    return {
      type: 'box',
      x: stat.laps.map(() => stat.driver),
      y: stat.laps.map(l => l.lap_time),
      name: stat.driver,
      boxpoints: false,
      line: { color: getDriverColour(stat.driver, stat.team) },
      fillcolor: 'rgba(0,0,0,0)',
      showlegend: false,
    };
  });

  const compounds = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET', 'UNKNOWN'];
  
  const driverCompoundTraces: Plotly.Data[] = compounds.map(comp => {
    const compLaps = filteredLaps.filter(l => (l.compound?.toUpperCase() || 'UNKNOWN') === comp);
    if (compLaps.length === 0) return null;
    return {
      type: 'box',
      x: compLaps.map(l => l.driver),
      y: compLaps.map(l => l.lap_time),
      name: comp,
      boxpoints: 'all',
      jitter: 0.3,
      pointpos: 0,
      fillcolor: 'rgba(0,0,0,0)',
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      marker: {
        color: compoundColors[comp],
        size: 4,
        opacity: 0.8,
        line: { color: 'rgba(255,255,255,0.2)', width: 1 }
      },
      hoverinfo: 'text',
      hoveron: 'points',
      text: compLaps.map(l => `Lap ${l.lap_number}<br>${formatLapTime(l.lap_time)}<br>${l.compound}`),
      showlegend: true,
    } as Plotly.Data;
  }).filter((t): t is Plotly.Data => t !== null);

  const driverPlotData = [...driverBoxTraces, ...driverCompoundTraces];

  // Generate Plotly Data for Teams
  const teamBoxTraces: Plotly.Data[] = teamStats.map(stat => {
    return {
      type: 'box',
      x: stat.laps.map(() => stat.team),
      y: stat.laps.map(l => l.lap_time),
      name: stat.team,
      boxpoints: false,
      line: { color: getTeamColour(stat.team) },
      fillcolor: 'rgba(0,0,0,0)',
      showlegend: false,
    };
  });

  const teamCompoundTraces: Plotly.Data[] = compounds.map(comp => {
    const compLaps = filteredLaps.filter(l => (l.compound?.toUpperCase() || 'UNKNOWN') === comp);
    if (compLaps.length === 0) return null;
    return {
      type: 'box',
      x: compLaps.map(l => l.team),
      y: compLaps.map(l => l.lap_time),
      name: comp,
      boxpoints: 'all',
      jitter: 0.3,
      pointpos: 0,
      fillcolor: 'rgba(0,0,0,0)',
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      marker: {
        color: compoundColors[comp],
        size: 4,
        opacity: 0.8,
        line: { color: 'rgba(255,255,255,0.2)', width: 1 }
      },
      hoverinfo: 'text',
      hoveron: 'points',
      text: compLaps.map(l => `${l.driver} (Lap ${l.lap_number})<br>${formatLapTime(l.lap_time)}<br>${l.compound}`),
      showlegend: false, // Don't duplicate legend from driver plot
    } as Plotly.Data;
  }).filter((t): t is Plotly.Data => t !== null);

  const teamPlotData = [...teamBoxTraces, ...teamCompoundTraces];


  const layoutBase = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#a1a1aa', family: 'var(--font-sans)' },
    margin: { t: 40, r: 20, b: 60, l: 60 },
    yaxis: {
      title: { text: 'Lap Time (s)' },
      gridcolor: '#3f3f46',
      zeroline: false,
      autorange: 'reversed' as const, // fastest times at top
    },
    xaxis: {
      gridcolor: '#3f3f46',
      zeroline: false,
    },
    boxmode: 'overlay' as const,
  };

  return (
    <div style={{ padding: 'var(--space-6)', overflowY: 'auto', height: '100%', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-6)' }}>
        <div>
          <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Race Pace Analysis
          </h1>
          <p style={{ color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
            {session?.event_name} {session?.year} — {session?.session_type}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={filterFinishers} onChange={e => setFilterFinishers(e.target.checked)} />
            Only Finishers
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={filterProper} onChange={e => setFilterProper(e.target.checked)} />
            Proper Laptimes (&lt; 107%)
          </label>
          <button className="btn btn--outline" onClick={() => navigate('/')}>
            Back to Dashboard
          </button>
        </div>
      </div>

      {loading ? (
        <div className="state-loading">Loading pace data...</div>
      ) : error ? (
        <div className="state-error">{error}</div>
      ) : filteredLaps.length === 0 ? (
        <div className="state-empty">No lap data available for these filters.</div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--space-8)' }}>
          {/* DRIVER PACE SECTION */}
          <section>
            <h2 style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-4)', color: 'var(--text-primary)' }}>Driver Pace</h2>
            <div style={{ height: 500, backgroundColor: 'var(--surface-primary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', padding: 'var(--space-4)' }}>
              <Plot
                data={driverPlotData}
                layout={layoutBase}
                style={{ width: '100%', height: '100%' }}
                config={{ responsive: true, displayModeBar: false }}
              />
            </div>
            
            <div style={{ marginTop: 'var(--space-4)', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 'var(--fs-sm)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: 'var(--space-2)' }}>Rank</th>
                    <th style={{ padding: 'var(--space-2)' }}>Driver</th>
                    <th style={{ padding: 'var(--space-2)' }}>Team</th>
                    <th style={{ padding: 'var(--space-2)' }}>Fastest Lap</th>
                    <th style={{ padding: 'var(--space-2)' }}>Tyre</th>
                    <th style={{ padding: 'var(--space-2)' }}>Mean Lap Time</th>
                    <th style={{ padding: 'var(--space-2)' }}>Delta</th>
                    <th style={{ padding: 'var(--space-2)' }}>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {driverStats.map((stat, i) => {
                    const delta = stat.mean - driverFastest;
                    return (
                      <tr key={stat.driver} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: 'var(--space-2)' }}>{i + 1}</td>
                        <td style={{ padding: 'var(--space-2)', fontWeight: 600, color: getDriverColour(stat.driver, stat.team) }}>{stat.driver}</td>
                        <td style={{ padding: 'var(--space-2)' }}>{stat.team}</td>
                        <td style={{ padding: 'var(--space-2)' }}>{formatLapTime(stat.fastestLapTime)}</td>
                        <td style={{ padding: 'var(--space-2)' }}>
                          {stat.fastestLapCompound ? (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              backgroundColor: compoundColors[stat.fastestLapCompound.toUpperCase()] || '#888888',
                              color: ['HARD', 'MEDIUM'].includes(stat.fastestLapCompound.toUpperCase()) ? '#000000' : '#ffffff',
                              fontSize: '10px',
                              fontWeight: 'bold',
                              border: '1px solid rgba(255,255,255,0.2)'
                            }} title={stat.fastestLapCompound}>
                              {formatCompound(stat.fastestLapCompound)}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: 'var(--space-2)' }}>{formatLapTime(stat.mean)}</td>
                        <td style={{ padding: 'var(--space-2)' }}>{i === 0 ? 'Best' : `+${delta.toFixed(3)}s`}</td>
                        <td style={{ padding: 'var(--space-2)' }}>
                          <span style={{ 
                            padding: '2px 8px', 
                            borderRadius: '12px', 
                            backgroundColor: 'var(--surface-secondary)',
                            color: 'var(--text-secondary)'
                          }}>
                            {getPaceRating(delta)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* TEAM PACE SECTION */}
          <section>
            <h2 style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-4)', color: 'var(--text-primary)' }}>Team Pace</h2>
            <div style={{ height: 500, backgroundColor: 'var(--surface-primary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', padding: 'var(--space-4)' }}>
              <Plot
                data={teamPlotData}
                layout={layoutBase}
                style={{ width: '100%', height: '100%' }}
                config={{ responsive: true, displayModeBar: false }}
              />
            </div>

            <div style={{ marginTop: 'var(--space-4)', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 'var(--fs-sm)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: 'var(--space-2)' }}>Rank</th>
                    <th style={{ padding: 'var(--space-2)' }}>Team</th>
                    <th style={{ padding: 'var(--space-2)' }}>Mean Lap Time</th>
                    <th style={{ padding: 'var(--space-2)' }}>Fastest Lap</th>
                    <th style={{ padding: 'var(--space-2)' }}>Tyre</th>
                    <th style={{ padding: 'var(--space-2)' }}>Delta</th>
                    <th style={{ padding: 'var(--space-2)' }}>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {teamStats.map((stat, i) => {
                    const delta = stat.mean - teamFastest;
                    return (
                      <tr key={stat.team} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: 'var(--space-2)' }}>{i + 1}</td>
                        <td style={{ padding: 'var(--space-2)', fontWeight: 600, color: getTeamColour(stat.team) }}>{stat.team}</td>
                        <td style={{ padding: 'var(--space-2)' }}>{formatLapTime(stat.mean)}</td>
                        <td style={{ padding: 'var(--space-2)' }}>{formatLapTime(stat.fastestLapTime)}</td>
                        <td style={{ padding: 'var(--space-2)' }}>
                          {stat.fastestLapCompound ? (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              backgroundColor: compoundColors[stat.fastestLapCompound.toUpperCase()] || '#888888',
                              color: ['HARD', 'MEDIUM'].includes(stat.fastestLapCompound.toUpperCase()) ? '#000000' : '#ffffff',
                              fontSize: '10px',
                              fontWeight: 'bold',
                              border: '1px solid rgba(255,255,255,0.2)'
                            }} title={stat.fastestLapCompound}>
                              {formatCompound(stat.fastestLapCompound)}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: 'var(--space-2)' }}>{i === 0 ? 'Best' : `+${delta.toFixed(3)}s`}</td>
                        <td style={{ padding: 'var(--space-2)' }}>
                          <span style={{ 
                            padding: '2px 8px', 
                            borderRadius: '12px', 
                            backgroundColor: 'var(--surface-secondary)',
                            color: 'var(--text-secondary)'
                          }}>
                            {getPaceRating(delta)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default RacePacePage;
