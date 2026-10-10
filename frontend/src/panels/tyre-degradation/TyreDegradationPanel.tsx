/**
 * Tyre Degradation Panel — low-level view.
 *
 * Answers one question at a glance: how fast is each stint falling off in this session?
 * One horizontal bar per stint, coloured by compound, sorted by degradation rate.
 *
 * Deliberately shallow. No fitted curves, no confidence bands, no scatter, no model
 * comparison — those live on /tyre-degradation, reached via the Expand button. This panel
 * has to stay readable as one tile in a grid at minimum size, so it fetches
 * `detail: 'summary'` (~100ms for a full race, versus ~3.8s for the full payload with
 * bootstrap bands).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import { api } from '../../lib/api';
import type { TyreDegradationResponse, TyreDegradationStint } from '../../lib/api';
import { getCompoundColour } from '../../lib/colours';

const TyreDegradationPanel: React.FC<PanelProps> = ({ sessionKey, width }) => {
  const navigate = useNavigate();
  const [data, setData] = useState<TyreDegradationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlySignificant, setOnlySignificant] = useState(true);

  useEffect(() => {
    if (!sessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);

    api
      .getTyreDegradation(sessionKey, { detail: 'summary' })
      .then(response => {
        if (!isMounted) return;
        setData(response);
        setLoading(false);
      })
      .catch(err => {
        if (!isMounted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [sessionKey]);

  /**
   * Stints worth showing, steepest first.
   *
   * Insignificant stints are hidden by default rather than mixed in. A fit with no real
   * trend produces an extreme slope, so leaving them in would put the least meaningful
   * numbers at the top of a list sorted by degradation.
   */
  const stints = useMemo<TyreDegradationStint[]>(() => {
    if (!data) return [];
    return data.stints
      .filter(s => s.degradation.s_per_lap !== null)
      .filter(s => !onlySignificant || s.degradation.significant)
      .sort((a, b) => (b.degradation.s_per_lap ?? 0) - (a.degradation.s_per_lap ?? 0));
  }, [data, onlySignificant]);

  const hiddenCount = (data?.stints.length ?? 0) - stints.length;

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view tyre degradation</div>;
  }
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
  if (!data || stints.length === 0) {
    return (
      <div className="state-empty">
        {hiddenCount > 0
          ? `No stint showed measurable degradation (${hiddenCount} inconclusive)`
          : 'No fittable stints in this session'}
      </div>
    );
  }

  // ── Layout ────────────────────────────────────────────────────────
  const labelGutter = 86;
  const rowHeight = 20;
  const barHeight = 12;
  const chartWidth = Math.max(width - labelGutter - 56, 120);

  // Symmetric about zero when any stint improved, so a negative bar reads as negative
  // rather than as a short positive one.
  const values = stints.map(s => s.degradation.s_per_lap ?? 0);
  const maxAbs = Math.max(...values.map(Math.abs), 0.05);
  const hasNegative = Math.min(...values) < 0;
  const zeroX = hasNegative ? labelGutter + chartWidth / 2 : labelGutter;
  const scale = hasNegative ? chartWidth / 2 / maxAbs : chartWidth / maxAbs;

  const chartHeight = stints.length * rowHeight + 8;

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
          onClick={() => navigate('/tyre-degradation')}
          title="Open Full Page Analysis"
        >
          ⤢ Expand
        </button>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
          title="Hide stints whose degradation is within two standard errors of zero"
        >
          <input
            type="checkbox"
            checked={onlySignificant}
            onChange={e => setOnlySignificant(e.target.checked)}
          />
          Conclusive only
        </label>
      </div>

      {/* Compound medians — the one summary figure worth showing at tile size. */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-secondary)',
          paddingBottom: 'var(--space-2)',
        }}
      >
        {data.compound_summary
          .filter(c => c.median_deg_s_per_lap !== null)
          .map(c => (
            <span key={c.compound} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: getCompoundColour(c.compound),
                }}
              />
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {formatRate(c.median_deg_s_per_lap)}
              </span>
            </span>
          ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <svg width="100%" height={chartHeight} style={{ display: 'block' }}>
          {/* Zero reference, drawn only when bars can go both ways. */}
          {hasNegative && (
            <line
              x1={zeroX}
              y1={0}
              x2={zeroX}
              y2={chartHeight}
              stroke="var(--border-emphasis)"
              strokeWidth={1}
            />
          )}

          {stints.map((stint, i) => {
            const value = stint.degradation.s_per_lap ?? 0;
            const y = i * rowHeight + 4;
            const barLength = Math.abs(value) * scale;
            const x = value >= 0 ? zeroX : zeroX - barLength;
            const colour = getCompoundColour(stint.compound);

            // The standard error, drawn as a whisker. A wide whisker is the visual cue
            // that a steep-looking stint is not well measured.
            const se = stint.degradation.se_s_per_lap ?? 0;
            const seHalf = se * scale;
            const tipX = value >= 0 ? x + barLength : x;

            return (
              <g key={`${stint.driver}-${stint.stint}`}>
                <text
                  x={0}
                  y={y + barHeight - 2}
                  fontSize={10}
                  fill="var(--text-secondary)"
                  fontFamily="var(--font-mono)"
                >
                  {stint.driver} S{stint.stint}
                </text>

                <rect
                  x={x}
                  y={y}
                  width={Math.max(barLength, 1)}
                  height={barHeight}
                  fill={colour}
                  opacity={stint.degradation.window_source === 'nominal' ? 0.9 : 0.55}
                  rx={2}
                />

                {seHalf > 1 && (
                  <line
                    x1={tipX - seHalf}
                    y1={y + barHeight / 2}
                    x2={tipX + seHalf}
                    y2={y + barHeight / 2}
                    stroke="var(--text-tertiary)"
                    strokeWidth={1}
                  />
                )}

                <text
                  x={labelGutter + chartWidth + 4}
                  y={y + barHeight - 2}
                  fontSize={10}
                  fill="var(--text-tertiary)"
                  fontFamily="var(--font-mono)"
                >
                  {formatRate(value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-tertiary)',
          paddingTop: 'var(--space-2)',
          borderTop: '1px solid var(--border-default)',
        }}
      >
        s/lap · faded = measured over a short stint
        {hiddenCount > 0 && ` · ${hiddenCount} inconclusive hidden`}
        {/* Surfaced, not hidden: when a session's track evolution diverges from the assumed
            fuel effect, every absolute figure above is biased by the difference. */}
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

function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

registerPanel({
  id: 'tyre-degradation',
  title: 'Tyre Degradation',
  category: 'strategy',
  Component: TyreDegradationPanel,
});

export default TyreDegradationPanel;
