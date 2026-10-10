/**
 * Tyre Degradation Analysis — in-depth page.
 *
 * Where the depth lives, per this app's split: the dashboard panel gives a glanceable
 * ranking, and everything that needs room — fitted curves with confidence bands, the
 * per-lap scatter including rejected outliers, model selection, and the caveats that make
 * the numbers interpretable — belongs here.
 *
 * Sections:
 *   1. Degradation curves   fitted curve + 95% band + scatter, per selected driver
 *   2. Stint fits           model chosen, uncertainty, fit quality, cliff, anomaly
 *   3. Compound comparison  per-compound distribution for this session
 *   4. Corrections & caveats what was corrected for, and what was not
 *
 * Charts use Plotly, matching the page precedent set by RacePacePage and TelemetryPage
 * (the panels use hand-rolled SVG). Plotly's `fill: 'tonexty'` gives the confidence band
 * directly.
 */

import React, { useEffect, useMemo, useState } from 'react';
import _Plot from 'react-plotly.js';
import { api } from '../lib/api';
import type { TyreDegradationResponse, TyreDegradationStint } from '../lib/api';
import { useSessionStore } from '../store/sessionStore';
import { getCompoundColour } from '../lib/colours';
import { formatLapTime } from '../lib/format';

const Plot = (_Plot as any).default || _Plot;

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-panel)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border-default)',
  padding: 'var(--space-4)',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xl)',
  marginBottom: 'var(--space-3)',
  color: 'var(--text-primary)',
};

const selectStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-2)',
  borderRadius: 'var(--radius-md)',
  backgroundColor: 'var(--bg-raised)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  outline: 'none',
};

const TyreDegradationPage: React.FC = () => {
  const { activeSessionKey, sessions } = useSessionStore();
  const session = sessions.find(s => s.session_key === activeSessionKey);

  // Summary over the whole session drives the selectors and the compound comparison.
  const [summary, setSummary] = useState<TyreDegradationResponse | null>(null);
  // Full payload for the selected driver only — curves and bands are expensive, and a
  // driver-filtered request is ~140ms against ~3.8s for every stint in the race.
  const [detail, setDetail] = useState<TyreDegradationResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [driver, setDriver] = useState<string>('');
  const [compound, setCompound] = useState<string>('ALL');
  const [showBand, setShowBand] = useState(true);
  const [showOutliers, setShowOutliers] = useState(true);
  const [onlySignificant, setOnlySignificant] = useState(false);

  useEffect(() => {
    if (!activeSessionKey) return;
    let isMounted = true;
    setLoading(true);
    setError(null);
    setDetail(null);

    api
      .getTyreDegradation(activeSessionKey, { detail: 'summary' })
      .then(response => {
        if (!isMounted) return;
        setSummary(response);
        // Default to the driver with the most fitted stints, so the page opens on content.
        const counts = new Map<string, number>();
        for (const stint of response.stints) {
          counts.set(stint.driver, (counts.get(stint.driver) ?? 0) + 1);
        }
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        setDriver(best ? best[0] : '');
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
  }, [activeSessionKey]);

  useEffect(() => {
    if (!activeSessionKey || !driver) return;
    let isMounted = true;
    setLoadingDetail(true);

    api
      .getTyreDegradation(activeSessionKey, { driver, detail: 'full' })
      .then(response => {
        if (!isMounted) return;
        setDetail(response);
        setLoadingDetail(false);
      })
      .catch(() => {
        // Soft failure: the rest of the page is still useful without the curves.
        if (!isMounted) return;
        setDetail(null);
        setLoadingDetail(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeSessionKey, driver]);

  const drivers = useMemo(() => {
    if (!summary) return [];
    return [...new Set(summary.stints.map(s => s.driver))].sort();
  }, [summary]);

  const detailStints = useMemo<TyreDegradationStint[]>(() => {
    if (!detail) return [];
    return detail.stints.filter(s => compound === 'ALL' || s.compound === compound);
  }, [detail, compound]);

  const tableStints = useMemo<TyreDegradationStint[]>(() => {
    if (!summary) return [];
    return summary.stints
      .filter(s => compound === 'ALL' || s.compound === compound)
      .filter(s => !onlySignificant || s.degradation.significant)
      .sort((a, b) => (b.degradation.s_per_lap ?? 0) - (a.degradation.s_per_lap ?? 0));
  }, [summary, compound, onlySignificant]);

  // ── Plotly traces for section 1 ───────────────────────────────────
  const curveTraces = useMemo(() => {
    const traces: any[] = [];
    for (const stint of detailStints) {
      const colour = getCompoundColour(stint.compound);
      const label = `S${stint.stint} ${stint.compound ?? '?'}`;
      const group = `${stint.driver}-${stint.stint}`;

      const laps = (stint.laps ?? []).filter(l => showOutliers || !l.is_outlier);
      traces.push({
        x: laps.map(l => l.tyre_life),
        y: laps.map(l => l.lap_time_corrected),
        mode: 'markers',
        type: 'scatter',
        name: label,
        legendgroup: group,
        marker: {
          color: colour,
          size: 6,
          // Rejected laps shown hollow rather than hidden: seeing what the fit excluded is
          // how you tell a sound fit from a convenient one.
          symbol: laps.map(l => (l.is_outlier ? 'circle-open' : 'circle')),
          opacity: 0.85,
        },
        hovertemplate: 'Tyre life %{x}<br>%{y:.3f}s<extra></extra>',
      });

      const curve = stint.curve ?? [];
      if (curve.length === 0) continue;

      const hasBand = showBand && curve[0].lo !== null;
      if (hasBand) {
        // Upper bound drawn invisibly, then the lower bound fills down to it.
        traces.push({
          x: curve.map(p => p.tyre_life),
          y: curve.map(p => p.hi),
          mode: 'lines',
          type: 'scatter',
          line: { width: 0 },
          legendgroup: group,
          showlegend: false,
          hoverinfo: 'skip',
        });
        traces.push({
          x: curve.map(p => p.tyre_life),
          y: curve.map(p => p.lo),
          mode: 'lines',
          type: 'scatter',
          line: { width: 0 },
          fill: 'tonexty',
          fillcolor: hexToRgba(colour, 0.15),
          legendgroup: group,
          showlegend: false,
          hoverinfo: 'skip',
        });
      }

      traces.push({
        x: curve.map(p => p.tyre_life),
        y: curve.map(p => p.fit),
        mode: 'lines',
        type: 'scatter',
        name: `${label} fit`,
        legendgroup: group,
        showlegend: false,
        line: { color: colour, width: 2 },
        hovertemplate: 'Tyre life %{x}<br>fit %{y:.3f}s<extra></extra>',
      });
    }
    return traces;
  }, [detailStints, showBand, showOutliers]);

  const curveLayout = useMemo(
    () => ({
      autosize: true,
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: '#a1a1aa', family: 'var(--font-sans)', size: 11 },
      margin: { t: 10, r: 10, b: 44, l: 60 },
      xaxis: { title: 'Tyre life (laps)', gridcolor: '#3f3f46', zeroline: false },
      yaxis: { title: 'Corrected lap time (s)', gridcolor: '#3f3f46', zeroline: false },
      hovermode: 'closest' as const,
      legend: { orientation: 'h' as const, y: -0.2 },
    }),
    []
  );

  const compoundTraces = useMemo(() => {
    if (!summary) return [];
    const byCompound = new Map<string, number[]>();
    for (const stint of summary.stints) {
      if (!stint.degradation.comparable || stint.degradation.s_per_lap === null) continue;
      const key = stint.compound ?? 'UNKNOWN';
      if (!byCompound.has(key)) byCompound.set(key, []);
      byCompound.get(key)!.push(stint.degradation.s_per_lap);
    }
    return [...byCompound.entries()].map(([comp, values]) => ({
      y: values,
      type: 'box' as const,
      name: comp,
      marker: { color: getCompoundColour(comp) },
      boxpoints: 'all' as const,
      jitter: 0.4,
      pointpos: 0,
    }));
  }, [summary]);

  // ── States ────────────────────────────────────────────────────────
  if (!activeSessionKey) {
    return <div className="state-empty">Select a session to analyse tyre degradation</div>;
  }
  if (loading) {
    return <div className="state-loading">Loading degradation fits…</div>;
  }
  if (error) {
    return <div className="state-error">{error}</div>;
  }
  if (!summary || summary.stints.length === 0) {
    return (
      <div className="state-empty">
        No fittable stints in this session.
        {summary?.warnings.map(w => (
          <div key={w} style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-sm)' }}>
            {w}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-6)', overflowY: 'auto', height: '100%', width: '100%' }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-6)',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Tyre Degradation Analysis
          </h1>
          <p style={{ color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
            {session?.event_name} {session?.year} — {session?.session_type}
            {summary.session_median_lap_time
              ? ` · median lap ${formatLapTime(summary.session_median_lap_time)}`
              : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={driver} onChange={e => setDriver(e.target.value)} style={selectStyle}>
            {drivers.map(d => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select value={compound} onChange={e => setCompound(e.target.value)} style={selectStyle}>
            <option value="ALL">All Compounds</option>
            {summary.compound_summary.map(c => (
              <option key={c.compound} value={c.compound}>
                {c.compound}
              </option>
            ))}
          </select>
          <Checkbox label="95% band" checked={showBand} onChange={setShowBand} />
          <Checkbox label="Show outliers" checked={showOutliers} onChange={setShowOutliers} />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
        {/* ── 1. Curves ──────────────────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Degradation Curves — {driver}</h2>
          <div style={{ ...cardStyle, height: 460 }}>
            {loadingDetail ? (
              <div className="state-loading">Fitting curves…</div>
            ) : detailStints.length === 0 ? (
              <div className="state-empty">No stints for this driver and compound</div>
            ) : (
              <Plot
                data={curveTraces}
                layout={curveLayout}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
              />
            )}
          </div>
        </section>

        {/* ── 2. Stint fits ──────────────────────────────────────── */}
        <section>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 'var(--space-3)',
            }}
          >
            <h2 style={{ ...sectionTitleStyle, marginBottom: 0 }}>Stint Fits</h2>
            <Checkbox
              label="Conclusive only"
              checked={onlySignificant}
              onChange={setOnlySignificant}
            />
          </div>
          <div style={{ ...cardStyle, overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 'var(--fs-sm)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  <Th align="left">Driver</Th>
                  <Th align="left">Stint</Th>
                  <Th align="left">Compound</Th>
                  <Th>Deg s/lap</Th>
                  <Th>± SE</Th>
                  <Th>Window</Th>
                  <Th>Laps</Th>
                  <Th>Model</Th>
                  <Th>R²</Th>
                  <Th>RMSE</Th>
                  <Th>Cliff</Th>
                  <Th>z</Th>
                </tr>
              </thead>
              <tbody>
                {tableStints.map(s => {
                  const d = s.degradation;
                  const dim = !d.significant;
                  return (
                    <tr
                      key={`${s.driver}-${s.stint}`}
                      style={{
                        borderTop: '1px solid var(--border-default)',
                        color: dim ? 'var(--text-tertiary)' : 'var(--text-primary)',
                        textAlign: 'right',
                      }}
                      title={
                        dim
                          ? 'Within two standard errors of zero — no measurable degradation'
                          : undefined
                      }
                    >
                      <Td align="left">{s.driver}</Td>
                      <Td align="left">{s.stint}</Td>
                      <Td align="left">
                        <span style={{ color: getCompoundColour(s.compound) }}>
                          {s.compound}
                        </span>
                      </Td>
                      <Td>{fmt(d.s_per_lap, 4, true)}</Td>
                      <Td>{fmt(d.se_s_per_lap, 4)}</Td>
                      <Td>
                        {d.window_lo}–{d.window_hi}
                        {d.window_source === 'observed' && (
                          <span
                            style={{ color: 'var(--accent-amber)' }}
                            title="Measured over the stint's own range, not the nominal 5–15 window. Not comparable with nominal figures."
                          >
                            *
                          </span>
                        )}
                      </Td>
                      <Td>
                        {s.n_laps_clean}
                        {s.n_laps_dropped_outlier > 0 && (
                          <span style={{ color: 'var(--text-tertiary)' }}>
                            {' '}
                            (−{s.n_laps_dropped_outlier})
                          </span>
                        )}
                      </Td>
                      <Td>{s.model}</Td>
                      <Td>{fmt(s.fit.r2, 3)}</Td>
                      <Td>{fmt(s.fit.rmse, 3)}</Td>
                      <Td>{s.cliff_tyre_life === null ? '—' : s.cliff_tyre_life}</Td>
                      <Td>
                        {s.anomaly ? (
                          <span
                            style={{
                              color: s.anomaly.is_anomalous
                                ? 'var(--accent-amber)'
                                : undefined,
                            }}
                            title={`vs ${s.anomaly.peer_count} peers in ${s.anomaly.peer_group}`}
                          >
                            {fmt(s.anomaly.z_score, 2, true)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p
              style={{
                marginTop: 'var(--space-3)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-tertiary)',
              }}
            >
              Degradation is a finite difference of the fitted curve across the stated window,
              not a model coefficient — coefficients are not comparable between the linear and
              quadratic fits. An asterisk marks a stint measured over its own range rather
              than the nominal {summary.config.nominal_window.join('–')} window; those figures
              are not comparable with the rest. Dimmed rows are within two standard errors of
              zero.
            </p>
          </div>
        </section>

        {/* ── 3. Compound comparison ─────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Compound Comparison</h2>
          <div style={{ ...cardStyle, height: 360 }}>
            {compoundTraces.length === 0 ? (
              <div className="state-empty">No conclusive stints to compare</div>
            ) : (
              <Plot
                data={compoundTraces}
                layout={{
                  autosize: true,
                  paper_bgcolor: 'transparent',
                  plot_bgcolor: 'transparent',
                  font: { color: '#a1a1aa', family: 'var(--font-sans)', size: 11 },
                  margin: { t: 10, r: 10, b: 40, l: 60 },
                  yaxis: { title: 'Degradation (s/lap)', gridcolor: '#3f3f46', zeroline: true },
                  xaxis: { gridcolor: '#3f3f46' },
                  showlegend: false,
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
              />
            )}
          </div>
        </section>

        {/* ── 4. Corrections and caveats ─────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Corrections &amp; Caveats</h2>
          <div style={{ ...cardStyle, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            <dl style={{ display: 'grid', gap: 'var(--space-2)', margin: 0 }}>
              <Row label="Corrections applied">
                {summary.config.corrections_applied.length === 0
                  ? 'none'
                  : summary.config.corrections_applied.map(describeCorrection).join('; ')}
              </Row>
              {summary.config.corrections_skipped.map(c => (
                <Row key={c.name} label={`Not corrected: ${c.name}`}>
                  {c.reason}
                </Row>
              ))}
              <Row label="Field pace trend">
                {summary.config.field_trend_s_per_lap === null
                  ? 'not measurable'
                  : `${fmt(summary.config.field_trend_s_per_lap, 4, true)} s/lap — the combined
                     effect of fuel burn-off, track evolution and the field's own average
                     degradation`}
              </Row>
              <Row label="Clean laps used">
                {summary.config.n_clean_laps} (stints of at least {summary.config.min_laps}{' '}
                clean laps, green-flag only, pit laps excluded)
              </Row>
            </dl>

            {summary.warnings.length > 0 && (
              <div
                style={{
                  marginTop: 'var(--space-4)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--accent-amber)',
                  color: 'var(--text-primary)',
                }}
              >
                {summary.warnings.map(w => (
                  <p key={w} style={{ margin: 0 }}>
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}

            <p style={{ marginTop: 'var(--space-4)', color: 'var(--text-tertiary)' }}>
              Teams pit before a tyre falls off its cliff, so every stint is cut short at the
              point degradation would have become most visible. Observed degradation therefore
              understates the true rate, and by a different amount for each compound — which is
              why these figures support comparisons within a session but not claims about
              which compound degrades fastest in general.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};

// ── Small presentational helpers ────────────────────────────────────

const Checkbox: React.FC<{
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <label
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-2)',
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-secondary)',
      cursor: 'pointer',
    }}
  >
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    {label}
  </label>
);

const Th: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({
  children,
  align = 'right',
}) => (
  <th style={{ padding: 'var(--space-1) var(--space-2)', textAlign: align, fontWeight: 500 }}>
    {children}
  </th>
);

const Td: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({
  children,
  align = 'right',
}) => <td style={{ padding: 'var(--space-1) var(--space-2)', textAlign: align }}>{children}</td>;

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
    <dt style={{ minWidth: 170, color: 'var(--text-tertiary)' }}>{label}</dt>
    <dd style={{ margin: 0, flex: 1 }}>{children}</dd>
  </div>
);

/**
 * Render one applied correction in prose.
 *
 * The backend returns each correction's own parameters as free-form keys, so this reads
 * the ones it recognises and falls back to listing the rest rather than dumping JSON at
 * the reader.
 */
function describeCorrection(correction: { name: string; [key: string]: unknown }): string {
  const { name, ...params } = correction;
  if (name === 'fuel' && typeof params.coef_s_per_lap === 'number') {
    return `fuel — ${params.coef_s_per_lap} s/lap, applied against absolute lap number`;
  }
  if (name === 'track_temp' && typeof params.coef_s_per_degree === 'number') {
    return `track temperature — ${params.coef_s_per_degree} s/°C about a mean of ${
      params.mean_track_temp ?? '?'
    }°C`;
  }
  const rest = Object.entries(params)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  return rest ? `${name} (${rest})` : name;
}

function fmt(value: number | null, digits: number, signed = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const text = value.toFixed(digits);
  return signed && value >= 0 ? `+${text}` : text;
}

/** Plotly needs rgba() for fill colours; the shared palette stores hex. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default TyreDegradationPage;
