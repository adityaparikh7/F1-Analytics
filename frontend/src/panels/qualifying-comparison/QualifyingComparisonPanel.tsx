/**
 * F1 Pitwall — Qualifying Comparison Panel
 *
 * Head-to-head sector and lap time comparison between two drivers.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { LapData } from '../../lib/api';
import { api } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';
import { formatLapTime, formatSectorTime } from '../../lib/format';

const QualifyingComparisonPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const [laps, setLaps] = useState<LapData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driver1, setDriver1] = useState('');
  const [driver2, setDriver2] = useState('');

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getLaps(sessionKey)
      .then(data => { setLaps(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  // Get unique drivers
  const drivers = useMemo(() => {
    const set = new Set<string>();
    laps.forEach(l => set.add(l.driver));
    return Array.from(set).sort();
  }, [laps]);

  // Set defaults
  useEffect(() => {
    if (drivers.length >= 2 && !driver1 && !driver2) {
      setDriver1(drivers[0]);
      setDriver2(drivers[1]);
    }
  }, [drivers]);

  // Find best laps for each driver
  const getBestLap = (driver: string): LapData | null => {
    const driverLaps = laps.filter(l => l.driver === driver && l.lap_time != null && l.lap_time > 0);
    if (driverLaps.length === 0) return null;
    return driverLaps.reduce((best, l) => (l.lap_time! < best.lap_time! ? l : best));
  };

  if (!sessionKey) return <div className="state-empty">Select a qualifying session</div>;
  if (loading) return <div className="state-loading"><div className="skeleton skeleton--bar" /><div className="skeleton skeleton--bar" /></div>;
  if (error) return <div className="state-error">{error}</div>;

  const best1 = getBestLap(driver1);
  const best2 = getBestLap(driver2);
  const colour1 = getDriverColour(driver1, best1?.team);
  const colour2 = getDriverColour(driver2, best2?.team);

  const renderDelta = (t1: number | null | undefined, t2: number | null | undefined) => {
    if (t1 == null || t2 == null) return <span className="text-tertiary">—</span>;
    const delta = t1 - t2;
    const isFaster = delta < 0;
    return (
      <span style={{ color: isFaster ? colour1 : colour2, fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>
        {delta > 0 ? '+' : ''}{delta.toFixed(3)}s
      </span>
    );
  };

  return (
    <div>
      {/* Driver selectors */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        <select value={driver1} onChange={e => setDriver1(e.target.value)}
          style={{ flex: 1, background: 'var(--bg-raised)', borderColor: colour1 }}>
          {drivers.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="text-tertiary" style={{ fontSize: 'var(--fs-sm)' }}>vs</span>
        <select value={driver2} onChange={e => setDriver2(e.target.value)}
          style={{ flex: 1, background: 'var(--bg-raised)', borderColor: colour2 }}>
          {drivers.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Comparison table */}
      {(best1 || best2) ? (
        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              <th style={{ color: colour1 }}>{driver1}</th>
              <th style={{ color: colour2 }}>{driver2}</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 600 }}>Lap Time</td>
              <td style={{ color: colour1 }}>{formatLapTime(best1?.lap_time)}</td>
              <td style={{ color: colour2 }}>{formatLapTime(best2?.lap_time)}</td>
              <td>{renderDelta(best1?.lap_time, best2?.lap_time)}</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>S1</td>
              <td>{formatSectorTime(best1?.sector1_time)}</td>
              <td>{formatSectorTime(best2?.sector1_time)}</td>
              <td>{renderDelta(best1?.sector1_time, best2?.sector1_time)}</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>S2</td>
              <td>{formatSectorTime(best1?.sector2_time)}</td>
              <td>{formatSectorTime(best2?.sector2_time)}</td>
              <td>{renderDelta(best1?.sector2_time, best2?.sector2_time)}</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 600 }}>S3</td>
              <td>{formatSectorTime(best1?.sector3_time)}</td>
              <td>{formatSectorTime(best2?.sector3_time)}</td>
              <td>{renderDelta(best1?.sector3_time, best2?.sector3_time)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="state-empty">Select two drivers with lap data</div>
      )}
    </div>
  );
};

registerPanel({ id: 'qualifying-comparison', title: 'Qualifying Comparison', category: 'telemetry', Component: QualifyingComparisonPanel });
export default QualifyingComparisonPanel;
