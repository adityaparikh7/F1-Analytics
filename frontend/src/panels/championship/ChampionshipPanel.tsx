/**
 * Championship Battle Panel — low-level view.
 *
 * Answers one question at a glance: who can still win the drivers' title, and how likely
 * is each of them to? One row per driver still in contention — points, gap to the leader,
 * simulated title odds — with the eliminated summarised in a single line.
 *
 * Deliberately shallow. Trajectories, the elimination chart, constructors, backtests and
 * what-if scenarios live on /championship, reached via the Expand button. It follows the
 * year selector rather than the active session, like the standings panels.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import { api } from '../../lib/api';
import type { ChampionshipProjection } from '../../lib/api';
import { getDriverColour } from '../../lib/colours';
import { formatPoints, formatTitleOdds } from '../../lib/format';
import { useSessionStore } from '../../store/sessionStore';

interface Loaded {
  year: number;
  data?: ChampionshipProjection;
  error?: string;
}

const ChampionshipPanel: React.FC<PanelProps> = ({ width }) => {
  const navigate = useNavigate();
  const selectedYear = useSessionStore(s => s.selectedYear);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Re-fetch quietly when the tab regains focus: a race can be ingested (or its points
    // backfilled) by the backend after this panel first loaded, and nothing else tells us.
    // A failed refresh keeps what is already on screen.
    const load = () => {
      api
        .getChampionshipProjection(selectedYear)
        .then(data => {
          if (!cancelled) setLoaded({ year: selectedYear, data });
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setLoaded(prev =>
            prev?.year === selectedYear && prev.data ? prev : { year: selectedYear, error: err.message }
          );
        });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [selectedYear]);

  if (!loaded || loaded.year !== selectedYear) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }
  if (loaded.error || !loaded.data) {
    return loaded.error?.startsWith('API Error 404') ? (
      <div className="state-empty">No race results ingested for {selectedYear} yet</div>
    ) : (
      <div className="state-error">{loaded.error}</div>
    );
  }

  const data = loaded.data;
  const contenders = data.drivers.filter(d => d.status !== 'eliminated');
  const eliminated = data.drivers.length - contenders.length;
  const clinch = data.earliest_clinch.drivers;
  const showTeam = width >= 380;
  const asOf = data.as_of_session;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '0 0 var(--space-2) 0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}
      >
        <button
          className="btn btn--outline"
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
          onClick={() => navigate('/championship')}
          title="Open Full Page Analysis"
        >
          ⤢ Expand
        </button>
        <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {data.season_complete
            ? `${data.year} season complete`
            : `After R${asOf.round_number}${asOf.session_type === 'S' ? ' sprint' : ''} · ${formatPoints(
                data.max_points_remaining.driver
              )} pts left`}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {contenders.map(d => {
          const colour = getDriverColour(d.driver, d.team);
          return (
            <div
              key={d.driver}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: '5px 0',
                borderBottom: '1px solid var(--border-default)',
              }}
            >
              <span
                className="mono"
                style={{ width: 20, textAlign: 'right', fontSize: 'var(--fs-sm)', color: 'var(--text-tertiary)' }}
              >
                {d.position}
              </span>
              <span style={{ width: 3, height: 18, borderRadius: 1, background: colour, flexShrink: 0 }} />
              <div style={{ width: showTeam ? 116 : 36, minWidth: 0, flexShrink: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{d.driver}</span>
                {showTeam && (
                  <span className="text-tertiary" style={{ fontSize: 'var(--fs-xs)', marginLeft: 6 }}>
                    {d.team}
                  </span>
                )}
              </div>
              <span className="mono" style={{ width: 44, textAlign: 'right', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
                {formatPoints(d.points)}
              </span>
              <span
                className="mono"
                style={{ width: 40, textAlign: 'right', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}
              >
                {d.gap_to_leader > 0 ? `−${formatPoints(d.gap_to_leader)}` : ''}
              </span>
              {/* Absolute scale: a full-width bar is a certain title. */}
              <div style={{ flex: 1, height: 6, background: 'var(--bg-raised)', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${d.title_probability * 100}%`,
                    minWidth: d.title_probability > 0 ? 2 : 0,
                    background: colour,
                    borderRadius: 3,
                  }}
                />
              </div>
              <span
                className="mono"
                style={{
                  width: 52,
                  textAlign: 'right',
                  fontSize: 'var(--fs-xs)',
                  color: d.status === 'clinched' ? 'var(--accent-teal)' : 'var(--text-primary)',
                }}
              >
                {formatTitleOdds(d.title_probability, d.status, data.season_complete)}
              </span>
            </div>
          );
        })}
        {eliminated > 0 && (
          <div style={{ padding: '6px 0', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
            +{eliminated} mathematically out of contention
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-tertiary)',
          paddingTop: 'var(--space-2)',
          borderTop: '1px solid var(--border-default)',
        }}
      >
        title odds · {data.config.n_sims.toLocaleString()} simulated seasons
        {clinch && ` · clinch possible from R${clinch.round_number}`}
        {data.warnings.length > 0 && (
          <span style={{ color: 'var(--accent-amber)' }} title={data.warnings.join(' ')}>
            {' '}
            · ⚠ see notes
          </span>
        )}
      </div>
    </div>
  );
};

registerPanel({
  id: 'championship',
  title: 'Championship Battle',
  category: 'session',
  Component: ChampionshipPanel,
});

export default ChampionshipPanel;
