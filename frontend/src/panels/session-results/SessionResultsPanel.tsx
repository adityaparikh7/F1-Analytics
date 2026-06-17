/**
 * F1 Pitwall — Session Results Panel
 *
 * Classified finishing order with position, driver, team, gap, status.
 * Supports Race, Sprint, Qualifying, Sprint Qualifying, and Practice sessions
 * with session-type-specific columns and data.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { ResultData } from '../../lib/api';
import { api } from '../../lib/api';
import { formatPosition, formatPoints, formatLapTime, formatGap, formatRaceTime } from '../../lib/format';
import { getDriverColour } from '../../lib/colours';

// ── Helpers ────────────────────────────────────────────────────────────

type SessionCategory = 'race' | 'qualifying' | 'practice';

/** Parse session type from session key (e.g. "2025_06_Q" → "Q") */
function getSessionType(sessionKey: string): string {
  return sessionKey.split('_').slice(2).join('_');
}

/** Classify session type into a display category */
function getSessionCategory(sessionKey: string): SessionCategory {
  const type = getSessionType(sessionKey);
  if (['Q', 'SQ', 'SS'].includes(type)) return 'qualifying';
  if (['FP1', 'FP2', 'FP3'].includes(type)) return 'practice';
  return 'race';
}

/**
 * Determine the display text for the Time / Gap column in race results.
 * - P1 (leader): full elapsed race time (e.g. "1:32:45.123")
 * - On-lead-lap finishers: gap string (e.g. "+4.567")
 * - Lapped drivers: "+N Lap(s)" extracted from status
 * - DNF / retired: "—"
 */
function getRaceTimeGap(
  r: ResultData,
  isLeader: boolean,
): { text: string; className: string } {
  if (isLeader) {
    return { text: formatRaceTime(r.time), className: '' };
  }

  // Lapped drivers: status contains "+1 Lap", "+2 Laps", etc.
  const lapMatch = r.status?.match(/^\+\s*(\d+)\s+Lap/i);
  if (lapMatch) {
    const lapCount = parseInt(lapMatch[1], 10);
    const label = lapCount === 1 ? '+1 Lap' : `+${lapCount} Laps`;
    return { text: label, className: 'text-amber' };
  }

  // DNF / retired / disqualified — no time to show
  if (
    r.status && r.status !== 'Finished' &&
    !r.gap_to_leader
  ) {
    return { text: 'DNF', className: 'text-red' };
  }

  // On-lead-lap finisher: show time gap
  if (r.gap_to_leader) {
    return { text: formatGap(r.gap_to_leader), className: 'text-secondary' };
  }

  return { text: '—', className: 'text-tertiary' };
}

// ── Shared Driver Cell ─────────────────────────────────────────────────

const DriverCell: React.FC<{ driver: string; driverNumber?: number | null; team?: string | null }> = ({
  driver,
  driverNumber,
  team,
}) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <span
      style={{
        width: 3,
        height: 16,
        borderRadius: 1,
        background: getDriverColour(driver, team ?? undefined),
        flexShrink: 0,
      }}
    />
    <span style={{ fontWeight: 600 }}>{driver}</span>
    {driverNumber != null && (
      <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
        #{driverNumber}
      </span>
    )}
  </span>
);

// ── Race / Sprint Table ────────────────────────────────────────────────

const RaceResultsTable: React.FC<{ results: ResultData[] }> = ({ results }) => (
  <table className="data-table">
    <thead>
      <tr>
        <th>Pos</th>
        <th>Driver</th>
        <th>Team</th>
        <th>Time / Gap</th>
        <th>Status</th>
        <th>Points</th>
        <th>Grid</th>
      </tr>
    </thead>
    <tbody>
      {results.map((r, idx) => {
        const isLeader = idx === 0 && r.position === 1;
        const { text: timeText, className: timeCls } = getRaceTimeGap(r, isLeader);

        return (
          <tr key={r.driver}>
            <td>
              <span className="data-table__position">{formatPosition(r.position)}</span>
            </td>
            <td>
              <DriverCell driver={r.driver} driverNumber={r.driver_number} team={r.team} />
            </td>
            <td className="text-secondary">{r.team || '—'}</td>
            <td className={timeCls} style={isLeader ? { fontWeight: 600 } : undefined}>
              {timeText}
            </td>
            <td className={r.status === 'Finished' ? 'text-teal' : r.status?.includes('DNF') ? 'text-red' : ''}>
              {r.status || '—'}
            </td>
            <td>{formatPoints(r.points)}</td>
            <td className="text-secondary">{formatPosition(r.grid_position)}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

// ── Qualifying Table ───────────────────────────────────────────────────

const QualifyingResultsTable: React.FC<{ results: ResultData[] }> = ({ results }) => {
  // Determine which Q columns have any data
  const hasQ1 = results.some(r => r.q1_time != null);
  const hasQ2 = results.some(r => r.q2_time != null);
  const hasQ3 = results.some(r => r.q3_time != null);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Pos</th>
          <th>Driver</th>
          <th>Team</th>
          {hasQ1 && <th>Q1</th>}
          {hasQ2 && <th>Q2</th>}
          {hasQ3 && <th>Q3</th>}
          <th>Best</th>
          <th>Gap</th>
        </tr>
      </thead>
      <tbody>
        {results.map(r => {
          // Determine which Q session the driver was knocked out in
          const knockedOutQ1 = hasQ2 && r.q2_time == null && r.q1_time != null;
          const knockedOutQ2 = hasQ3 && r.q3_time == null && r.q2_time != null;

          return (
            <tr
              key={r.driver}
              style={{
                opacity: knockedOutQ1 ? 0.55 : knockedOutQ2 ? 0.75 : 1,
              }}
            >
              <td>
                <span className="data-table__position">{formatPosition(r.position)}</span>
              </td>
              <td>
                <DriverCell driver={r.driver} driverNumber={r.driver_number} team={r.team} />
              </td>
              <td className="text-secondary">{r.team || '—'}</td>
              {hasQ1 && (
                <td className={knockedOutQ1 ? 'text-red' : ''}>
                  {formatLapTime(r.q1_time)}
                </td>
              )}
              {hasQ2 && (
                <td className={knockedOutQ2 ? 'text-red' : ''}>
                  {formatLapTime(r.q2_time)}
                </td>
              )}
              {hasQ3 && (
                <td className="text-teal">
                  {formatLapTime(r.q3_time)}
                </td>
              )}
              <td style={{ fontWeight: 600 }}>
                {formatLapTime(r.best_lap_time)}
              </td>
              <td className="text-secondary">
                {formatGap(r.gap_to_leader)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

// ── Practice Table ─────────────────────────────────────────────────────

const PracticeResultsTable: React.FC<{ results: ResultData[] }> = ({ results }) => (
  <table className="data-table">
    <thead>
      <tr>
        <th>Pos</th>
        <th>Driver</th>
        <th>Team</th>
        <th>Best Lap</th>
        <th>Gap</th>
      </tr>
    </thead>
    <tbody>
      {results.map(r => (
        <tr key={r.driver}>
          <td>
            <span className="data-table__position">{formatPosition(r.position)}</span>
          </td>
          <td>
            <DriverCell driver={r.driver} driverNumber={r.driver_number} team={r.team} />
          </td>
          <td className="text-secondary">{r.team || '—'}</td>
          <td style={{ fontWeight: 600 }}>
            {formatLapTime(r.best_lap_time)}
          </td>
          <td className="text-secondary">
            {formatGap(r.gap_to_leader)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

// ── Main Panel ─────────────────────────────────────────────────────────

const SessionResultsPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const [results, setResults] = useState<ResultData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = useMemo<SessionCategory | null>(
    () => (sessionKey ? getSessionCategory(sessionKey) : null),
    [sessionKey],
  );

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getResults(sessionKey)
      .then(data => { setResults(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view results</div>;
  }

  if (loading) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-error">
        {error}
        <button className="state-error__retry" onClick={() => setError(null)}>Retry</button>
      </div>
    );
  }

  if (results.length === 0) {
    return <div className="state-empty">No results available for this session</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      {category === 'qualifying' && <QualifyingResultsTable results={results} />}
      {category === 'practice' && <PracticeResultsTable results={results} />}
      {category === 'race' && <RaceResultsTable results={results} />}
    </div>
  );
};

registerPanel({
  id: 'session-results',
  title: 'Session Results',
  category: 'session',
  Component: SessionResultsPanel,
});

export default SessionResultsPanel;
