/**
 * F1 Pitwall — Constructor Standings Panel
 *
 * Constructor championship with horizontal stacked bar chart.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { ConstructorStanding } from '../../lib/api';
import { api } from '../../lib/api';
import { useSessionStore } from '../../store/sessionStore';
import { TEAM_COLOURS } from '../../lib/colours';
import { formatPosition, formatPoints } from '../../lib/format';

const ConstructorStandingsPanel: React.FC<PanelProps> = () => {
  const selectedYear = useSessionStore(s => s.selectedYear);
  const [standings, setStandings] = useState<ConstructorStanding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getConstructorStandings(selectedYear)
      .then(data => { setStandings(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [selectedYear]);

  if (loading) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return <div className="state-error">{error}</div>;
  }

  if (standings.length === 0) {
    return <div className="state-empty">No constructor standings for {selectedYear}</div>;
  }

  const maxPoints = Math.max(...standings.map(s => s.points), 1);

  return (
    <div style={{ overflowY: 'auto' }}>
      {standings.map(s => {
        const colour = TEAM_COLOURS[s.constructor] || TEAM_COLOURS[s.constructor.split(' ')[0]] || '#888890';
        const barWidth = (s.points / maxPoints) * 100;

        return (
          <div
            key={s.constructor}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 0',
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

            {/* Colour block */}
            <span style={{
              width: 4,
              height: 24,
              borderRadius: 2,
              background: colour,
              flexShrink: 0,
            }} />

            {/* Constructor info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)', marginBottom: 0 }}>
                {s.constructor}
              </div>
              {/* Points bar */}
              <div style={{
                height: 6,
                background: 'var(--bg-raised)',
                borderRadius: 3,
                overflow: 'hidden',
                display:"none"
              }}>
                <div style={{
                  height: '100%',
                  width: `${barWidth}%`,
                  background: `linear-gradient(90deg, ${colour}, ${colour}88)`,
                  borderRadius: 3,
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>

            {/* Points */}
            <span className="mono" style={{
              fontWeight: 600,
              fontSize: 'var(--fs-base)',
              minWidth: 48,
              textAlign: 'right',
            }}>
              {formatPoints(s.points)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

registerPanel({
  id: 'constructor-standings',
  title: 'Constructor Standings',
  category: 'session',
  Component: ConstructorStandingsPanel,
});

export default ConstructorStandingsPanel;
