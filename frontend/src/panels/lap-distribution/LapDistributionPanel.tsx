/**
 * LapDistributionPanel.tsx
 * 
 * Displays a box plot distribution of lap times for each driver in the session, with options to filter by proper laps and finishers.
 * Each driver's laps are shown as a box plot, with individual lap points colored by compound.
 * The panel fetches lap and result data from the API and computes the necessary statistics for display.
 * It also includes a button to navigate to a full-page analysis view and checkboxes to toggle filters.
 * Uses Plotly for rendering the box plots and points, with a custom color scheme for compounds and driver colors.
 * The component handles loading and error states gracefully, and updates the display based on user interactions with the filters.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { LapData, ResultData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';
import { formatLapTime, getProperLapThreshold } from '../../lib/format';
import _Plot from 'react-plotly.js';
const Plot = (_Plot as any).default || _Plot;
import { useNavigate } from 'react-router-dom';

const compoundColors: Record<string, string> = {
  SOFT: '#FF3333',
  MEDIUM: '#FFD700',
  HARD: '#FFFFFF',
  INTERMEDIATE: '#3CB371',
  WET: '#1E90FF',
  UNKNOWN: '#888888',
};

const LapDistributionPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const navigate = useNavigate();
  const [laps, setLaps] = useState<LapData[]>([]);
  const [results, setResults] = useState<ResultData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [filterProper, setFilterProper] = useState(true);
  const [filterFinishers, setFilterFinishers] = useState(false);

  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);
    
    Promise.all([
      api.getLaps(sessionKey, { exclude_pit_laps: false }),
      api.getResults(sessionKey).catch(() => [] as ResultData[])
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
  }, [sessionKey]);

  // Compute filtered laps and stats
  const { driverStats } = useMemo(() => {
    if (!laps.length) return { driverStats: [] };

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

    for (const lap of validLaps) {
      if (!driverMap.has(lap.driver)) driverMap.set(lap.driver, { team: lap.team, laps: [] });
      driverMap.get(lap.driver)!.laps.push(lap);
    }

    const stats = Array.from(driverMap.entries())
      .map(([driver, { team, laps }]) => {
        // We sort by median to match the original SVG implementation ordering
        const sortedTimes = [...laps].map(l => l.lap_time!).sort((a, b) => a - b);
        const median = sortedTimes[Math.floor(sortedTimes.length / 2)];
        return { driver, team, laps, median };
      })
      .sort((a, b) => a.median - b.median);

    return { driverStats: stats };
  }, [laps, results, filterProper, filterFinishers]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view lap distributions</div>;
  }

  if (loading && laps.length === 0) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return <div className="state-error">{error}</div>;
  }

  const driverBoxTraces: Plotly.Data[] = driverStats.map(stat => {
    return {
      type: 'box',
      x: stat.laps.map(() => stat.driver),
      y: stat.laps.map(l => l.lap_time),
      name: stat.driver,
      boxpoints: false,
      line: { color: getDriverColour(stat.driver, stat.team), width: 1 },
      fillcolor: 'rgba(0,0,0,0)',
      showlegend: false,
    };
  });

  const compounds = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET', 'UNKNOWN'];
  const driverCompoundTraces: Plotly.Data[] = compounds.map(comp => {
    // Collect all laps for this compound across all drivers to keep a single trace per compound (for legend if needed, though hidden here)
    const compLaps = driverStats.flatMap(stat => stat.laps).filter(l => (l.compound?.toUpperCase() || 'UNKNOWN') === comp);
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
        size: 3,
        opacity: 0.8,
      },
      hoverinfo: 'text',
      hoveron: 'points',
      text: compLaps.map(l => `Lap ${l.lap_number}<br>${formatLapTime(l.lap_time)}<br>${l.compound}`),
      showlegend: false,
    } as Plotly.Data;
  }).filter((t): t is Plotly.Data => t !== null);

  const plotData = [...driverBoxTraces, ...driverCompoundTraces];

  const layoutBase: Partial<Plotly.Layout> = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#a1a1aa', family: 'var(--font-sans)', size: 10 },
    margin: { t: 10, r: 10, b: 30, l: 40 },
    yaxis: {
      gridcolor: '#3f3f46',
      zeroline: false,
      autorange: 'reversed' as const,
    },
    xaxis: {
      gridcolor: '#3f3f46',
      zeroline: false,
    },
    boxmode: 'overlay' as const,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '0 0 var(--space-2) 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button 
          className="btn btn--outline" 
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
          onClick={() => navigate('/race-pace')}
          title="Open Full Page Analysis"
        >
          ⤢ Expand
        </button>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={filterFinishers} 
              onChange={e => setFilterFinishers(e.target.checked)} 
            />
            Only Finishers
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={filterProper} 
              onChange={e => setFilterProper(e.target.checked)} 
            />
            Proper Laptimes
          </label>
        </div>
      </div>
      
      {driverStats.length === 0 ? (
        <div className="state-empty">No lap time data available for this filter</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <Plot
            data={plotData}
            layout={layoutBase}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler={true}
            config={{ responsive: true, displayModeBar: false }}
          />
        </div>
      )}
    </div>
  );
};

registerPanel({
  id: 'lap-distribution',
  title: 'Lap Time Distribution',
  category: 'performance',
  Component: LapDistributionPanel,
});

export default LapDistributionPanel;
