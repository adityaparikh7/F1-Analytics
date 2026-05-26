/**
 * F1 Pitwall — Driver Standings Panel
 *
 * Championship standings with position, driver, team, points, and wins.
 * Includes a horizontal bar chart for visual point comparison.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { DriverStanding } from '../../lib/api';
import { api } from '../../lib/api';
import { useSessionStore } from '../../store/sessionStore';
import { getDriverColour } from '../../lib/colours';
import { formatPosition, formatPoints } from '../../lib/format';

const DriverStandingsPanel: React.FC<PanelProps> = () => {
  const selectedYear = useSessionStore(s => s.selectedYear);
  const [standings, setStandings] = useState<DriverStanding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getDriverStandings(selectedYear)
      .then(data => { setStandings(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [selectedYear]);

  if (loading) {
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

  if (standings.length === 0) {
    return <div className="state-empty">No standings data available for {selectedYear}</div>;
  }

  const maxPoints = Math.max(...standings.map(s => s.points), 1);

  return (
    <div style={{ overflowY: 'auto' }}>
      {standings.map(s => {
        const colour = getDriverColour(s.driver, s.team);
        const barWidth = (s.points / maxPoints) * 100;

        return (
          <div
            key={s.driver}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 0',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            {/* Position */}
            <span
              className="mono"
              style={{
                width: 28,
                textAlign: 'center',
                fontWeight: 600,
                fontSize: 'var(--fs-sm)',
                color: s.position <= 3 ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              {formatPosition(s.position)}
            </span>

            {/* Colour bar */}
            <span style={{ width: 3, height: 20, borderRadius: 1, background: colour, flexShrink: 0 }} />

            {/* Driver info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{s.driver}</span>
                <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
                  {s.team}
                </span>
              </div>
              {/* Points bar */}
              <div style={{
                height: 4,
                background: 'var(--bg-raised)',
                borderRadius: 2,
                marginTop: 3,
                overflow: 'hidden',
                display:"none"
              }}>
                <div style={{
                  height: '100%',
                  width: `${barWidth}%`,
                  background: colour,
                  borderRadius: 2,
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>

            {/* Wins */}
            {s.wins > 0 && (
              <span style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--accent-amber)',
                fontFamily: 'var(--font-mono)',
                minWidth: 24,
                textAlign: 'right',
              }}>
                {s.wins}W
              </span>
            )}
            {/* Points */}
            <span className="mono" style={{ fontWeight: 600, fontSize: 'var(--fs-sm)', minWidth: 40, textAlign: 'right' }}>
              {formatPoints(s.points)}
            </span>

          </div>
        );
      })}
    </div>
  );
};

registerPanel({
  id: 'driver-standings',
  title: 'Driver Standings',
  category: 'session',
  Component: DriverStandingsPanel,
});

export default DriverStandingsPanel;
