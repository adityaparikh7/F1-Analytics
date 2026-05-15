/**
 * F1 Pitwall — Session Results Panel
 *
 * Classified finishing order with position, driver, team, gap, status.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { ResultData } from '../../lib/api';
import { api } from '../../lib/api';
import { formatPosition, formatPoints } from '../../lib/format';
import { getDriverColour } from '../../lib/colours';

const SessionResultsPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const [results, setResults] = useState<ResultData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <table className="data-table">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Driver</th>
            <th>Team</th>
            <th>Status</th>
            <th>Points</th>
            <th>Grid</th>
          </tr>
        </thead>
        <tbody>
          {results.map(r => (
            <tr key={r.driver}>
              <td>
                <span className="data-table__position">{formatPosition(r.position)}</span>
              </td>
              <td>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    style={{
                      width: 3,
                      height: 16,
                      borderRadius: 1,
                      background: getDriverColour(r.driver, r.team),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{r.driver}</span>
                  {r.driver_number && (
                    <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
                      #{r.driver_number}
                    </span>
                  )}
                </span>
              </td>
              <td className="text-secondary">{r.team || '—'}</td>
              <td className={r.status === 'Finished' ? 'text-teal' : r.status?.includes('DNF') ? 'text-red' : ''}>
                {r.status || '—'}
              </td>
              <td>{formatPoints(r.points)}</td>
              <td className="text-secondary">{formatPosition(r.grid_position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
