/**
 * Championship — in-depth page.
 *
 * The dashboard panel answers "who is going to win?" at a glance; this page shows why, and
 * how sure to be. Sections:
 *   1. Title odds          standings, maximum possible points, simulated odds and ranges
 *   2. Season trajectory   actual points to date, then the projected fan to the season's end
 *   3. Who can still win   gap to the leader against the points still available
 *   4. What if             pin results in sessions still to run and re-simulate
 *   5. Method & caveats    the model in plain words, how it was calibrated, its blind spots
 *
 * The "as of" control rewinds the season: the projection is replayed as it stood after an
 * earlier round, with what actually happened alongside — the backtest behind the model's
 * calibration, made visible for any season.
 *
 * Charts use Plotly, matching the page precedent set by RacePacePage and TyreDegradationPage
 * (the panel uses plain markup).
 */

import React, { useEffect, useMemo, useState } from 'react';
import _Plot from 'react-plotly.js';
import type { Data, Layout } from 'plotly.js';
import { Play, Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';
import type {
  ChampionshipOdds,
  ChampionshipPin,
  ChampionshipProgression,
  ChampionshipProjection,
} from '../lib/api';
import { adjustColorLightness, getDriverColour, getTeamColour, withAlpha } from '../lib/colours';
import { formatPoints, formatTitleOdds } from '../lib/format';
import { useSessionStore } from '../store/sessionStore';

// react-plotly.js is CommonJS; under Vite the component can arrive wrapped in `default`.
const Plot = (_Plot as unknown as { default?: typeof _Plot }).default ?? _Plot;

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

const buttonStyle: React.CSSProperties = {
  ...selectStyle,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
};

const PLOT_FONT = { color: '#a1a1aa', family: 'var(--font-sans)', size: 11 };
const GRID_COLOUR = '#3f3f46';
const MUTED_COLOUR = '#71717a';

const SIM_OPTIONS = [2_000, 10_000, 50_000];
const FORM_OPTIONS = [5, 10, 20];
/** Contenders drawn on the charts — more than this and the lines stop being readable. */
const CHART_DEPTH = 8;

type Mode = 'drivers' | 'constructors';

/** A fetched payload tagged with the request it answers, so a stale response is never shown. */
interface Keyed<T> {
  key: string;
  data?: T;
  error?: string;
}

/** One row of either championship. */
interface Contender extends ChampionshipOdds {
  name: string;
  team: string | null;
  form?: { n_results: number; source: 'own' | 'pooled' | 'field' } | null;
}

interface PinDraft {
  id: number;
  /** `${round}|${session_type}` */
  session: string;
  driver: string;
  /** '1'…'22', or 'DNF' */
  position: string;
}

const ChampionshipPage: React.FC = () => {
  const year = useSessionStore(s => s.selectedYear);
  const [mode, setMode] = useState<Mode>('drivers');
  // Tagged with its year so switching season drops back to the latest round by itself.
  const [asOf, setAsOf] = useState<{ year: number; round: number } | null>(null);
  const asOfRound = asOf?.year === year ? asOf.round : null;
  const [nSims, setNSims] = useState(10_000);
  const [formWindow, setFormWindow] = useState(10);

  // ── Data ──────────────────────────────────────────────────────────
  const [progression, setProgression] = useState<Keyed<ChampionshipProgression> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = String(year);
    api
      .getChampionshipProgression(year)
      .then(data => {
        if (!cancelled) setProgression({ key, data });
      })
      .catch((err: Error) => {
        if (!cancelled) setProgression({ key, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const baselineKey = projectionKey(year, asOfRound, nSims, formWindow);
  const [baseline, setBaseline] = useState<Keyed<ChampionshipProjection> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = projectionKey(year, asOfRound, nSims, formWindow);
    api
      .getChampionshipProjection(year, { asOfRound: asOfRound ?? undefined, nSims, formWindow })
      .then(data => {
        if (!cancelled) setBaseline({ key, data });
      })
      .catch((err: Error) => {
        if (!cancelled) setBaseline({ key, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [year, asOfRound, nSims, formWindow]);

  // ── What-if ───────────────────────────────────────────────────────
  // Pins belong to one point in one season; rewinding or switching year leaves them behind.
  const pinContext = `${year}|${asOfRound ?? 'latest'}`;
  const [pinState, setPinState] = useState<{ context: string; pins: PinDraft[] }>({ context: '', pins: [] });
  const pins = useMemo(
    () => (pinState.context === pinContext ? pinState.pins : []),
    [pinState, pinContext]
  );
  const pinPayload = useMemo(() => pins.map(toPin), [pins]);
  // A scenario answers one exact set of pins: edit them and it no longer applies.
  const scenarioKey = `${baselineKey}|${JSON.stringify(pinPayload)}`;
  const [scenario, setScenario] = useState<(Keyed<ChampionshipProjection> & { running?: boolean }) | null>(
    null
  );
  const currentScenario = scenario?.key === scenarioKey ? scenario : null;

  const progressionData = progression?.key === String(year) ? progression.data : undefined;
  const baselineData = baseline?.key === baselineKey ? baseline.data : undefined;
  const projection = currentScenario?.data ?? baselineData;

  // ── Derived chart data ────────────────────────────────────────────
  const rows = useMemo(() => (projection ? contendersOf(projection, mode) : []), [projection, mode]);
  const baselineOdds = useMemo(
    () => new Map((baselineData ? contendersOf(baselineData, mode) : []).map(r => [r.name, r.title_probability])),
    [baselineData, mode]
  );
  const colours = useMemo(() => colourMap(rows, mode), [rows, mode]);
  const labels = useMemo(
    () => new Map((projection?.rounds ?? []).map(r => [r.round_number, shortEvent(r.event_name)])),
    [projection]
  );
  const series = useMemo(() => (progressionData ? seriesOf(progressionData, mode) : new Map()), [progressionData, mode]);
  const charted = useMemo(() => {
    const inContention = rows.filter(r => r.status !== 'eliminated').slice(0, CHART_DEPTH);
    return inContention.length >= 3 ? inContention : rows.slice(0, 5);
  }, [rows]);

  const trajectoryTraces = useMemo(
    () =>
      projection && progressionData
        ? buildTrajectoryTraces(projection, progressionData, charted, colours, series, labels)
        : [],
    [projection, progressionData, charted, colours, series, labels]
  );
  const eliminationTraces = useMemo(
    () =>
      projection && progressionData
        ? buildEliminationTraces(projection, progressionData, rows.slice(0, CHART_DEPTH), colours, series, labels, mode)
        : [],
    [projection, progressionData, rows, colours, series, labels, mode]
  );

  // ── States ────────────────────────────────────────────────────────
  if (progression?.key === String(year) && progression.error) {
    return progression.error.startsWith('API Error 404') ? (
      <div className="state-empty">No race results ingested for {year} yet</div>
    ) : (
      <div className="state-error">{progression.error}</div>
    );
  }
  if (baseline?.key === baselineKey && baseline.error) {
    return <div className="state-error">{baseline.error}</div>;
  }
  if (!projection || !baselineData || !progressionData) {
    return <div className="state-loading">Simulating {nSims.toLocaleString()} seasons…</div>;
  }

  // ── What-if editing ───────────────────────────────────────────────
  const setPins = (next: PinDraft[]) => setPinState({ context: pinContext, pins: next });
  const gridDrivers = baselineData.drivers.filter(d => d.eligible).map(d => d.driver);
  const positions = gridDrivers.map((_, i) => String(i + 1));
  const sessionValue = (s: { round_number: number; session_type: string }) => `${s.round_number}|${s.session_type}`;

  const addPin = () => {
    const first = baselineData.remaining[0];
    if (!first) return;
    const session = sessionValue(first);
    const sameSession = pins.filter(p => p.session === session);
    const driver = gridDrivers.find(d => !sameSession.some(p => p.driver === d)) ?? gridDrivers[0];
    const position = positions.find(p => !sameSession.some(pin => pin.position === p)) ?? 'DNF';
    const id = Math.max(0, ...pins.map(p => p.id)) + 1;
    setPins([...pins, { id, session, driver, position }]);
  };
  const updatePin = (id: number, change: Partial<PinDraft>) =>
    setPins(pins.map(p => (p.id === id ? { ...p, ...change } : p)));

  const runScenario = () => {
    const key = scenarioKey;
    setScenario({ key, running: true });
    api
      .simulateChampionship(year, pinPayload, { asOfRound: asOfRound ?? undefined, nSims, formWindow })
      .then(data => setScenario(prev => (prev?.key === key ? { key, data } : prev)))
      .catch((err: Error) => setScenario(prev => (prev?.key === key ? { key, error: err.message } : prev)));
  };
  const resetScenario = () => {
    setPins([]);
    setScenario(null);
  };

  // ── Render ────────────────────────────────────────────────────────
  const asOfSession = projection.as_of_session;
  const clinch = mode === 'drivers' ? projection.earliest_clinch.drivers : projection.earliest_clinch.constructors;
  const maxRemaining = mode === 'drivers' ? projection.max_points_remaining.driver : projection.max_points_remaining.team;
  const scenarioActive = Boolean(currentScenario?.data);
  const rangeMax = Math.max(1, ...rows.map(r => r.points_p90));
  const roundsWithResults = [...progressionData.round_numbers].reverse();
  const xAxis = {
    tickmode: 'array' as const,
    tickvals: projection.rounds.map(r => r.round_number),
    ticktext: projection.rounds.map(r => shortEvent(r.event_name)),
    tickangle: -45,
    gridcolor: GRID_COLOUR,
    zeroline: false,
  };
  const asOfMarker: Partial<Layout> = {
    shapes: [
      {
        type: 'line',
        x0: projection.as_of_round,
        x1: projection.as_of_round,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: MUTED_COLOUR, width: 1, dash: 'dot' },
      },
    ],
  };

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
            {year} Championship
            {projection.is_backtest && <Badge colour="var(--accent-amber)">Backtest</Badge>}
            {scenarioActive && <Badge colour="var(--accent-teal)">Scenario</Badge>}
          </h1>
          <p style={{ color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
            {projection.season_complete
              ? 'Season complete'
              : `After round ${asOfSession.round_number}, ${shortEvent(asOfSession.event_name)}${
                  asOfSession.session_type === 'S' ? ' Sprint' : ''
                } · ${formatPoints(maxRemaining)} pts still available`}
            {clinch && ` · earliest possible clinch: R${clinch.round_number} ${shortEvent(clinch.event_name)}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex' }}>
            {(['drivers', 'constructors'] as const).map((m, i) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  ...buttonStyle,
                  borderRadius: i === 0 ? 'var(--radius-md) 0 0 var(--radius-md)' : '0 var(--radius-md) var(--radius-md) 0',
                  backgroundColor: mode === m ? 'var(--bg-active)' : 'var(--bg-raised)',
                  color: mode === m ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {m === 'drivers' ? 'Drivers' : 'Constructors'}
              </button>
            ))}
          </div>
          <label style={labelStyle}>
            As of
            <select
              value={asOfRound ?? ''}
              onChange={e => setAsOf(e.target.value ? { year, round: Number(e.target.value) } : null)}
              style={selectStyle}
            >
              <option value="">Latest (R{progressionData.latest_round})</option>
              {roundsWithResults.slice(1).map(rnd => (
                <option key={rnd} value={rnd}>
                  R{rnd} {labels.get(rnd) ?? ''}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Sims
            <select value={nSims} onChange={e => setNSims(Number(e.target.value))} style={selectStyle}>
              {SIM_OPTIONS.map(n => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Form
            <select value={formWindow} onChange={e => setFormWindow(Number(e.target.value))} style={selectStyle}>
              {FORM_OPTIONS.map(n => (
                <option key={n} value={n}>
                  last {n} races
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
        {/* ── 1. Title odds ──────────────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Title Odds</h2>
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
                  <Th>Pos</Th>
                  <Th align="left">{mode === 'drivers' ? 'Driver' : 'Constructor'}</Th>
                  <Th>Pts</Th>
                  <Th>Gap</Th>
                  <Th>Max</Th>
                  <Th>Title</Th>
                  {scenarioActive && <Th>Δ pp</Th>}
                  <Th>Top 3</Th>
                  <Th align="left">Projected final · p10–p90</Th>
                  {projection.is_backtest && <Th>Actual</Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const colour = colours.get(row.name) ?? MUTED_COLOUR;
                  const out = row.status === 'eliminated';
                  const top3 = row.position_probabilities.slice(0, 3).reduce((a, b) => a + b, 0);
                  const delta = (row.title_probability - (baselineOdds.get(row.name) ?? 0)) * 100;
                  return (
                    <tr
                      key={row.name}
                      style={{
                        borderTop: '1px solid var(--border-default)',
                        color: out ? 'var(--text-tertiary)' : 'var(--text-primary)',
                        textAlign: 'right',
                      }}
                    >
                      <Td>{row.position}</Td>
                      <Td align="left">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                          <span style={{ width: 3, height: 14, borderRadius: 1, background: colour }} />
                          <span style={{ fontWeight: 600 }}>{row.name}</span>
                          {mode === 'drivers' && (
                            <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>
                              {row.team}
                            </span>
                          )}
                          {!row.eligible && (
                            <span style={{ color: 'var(--text-tertiary)' }} title="No longer on the grid: keeps their points, scores no more">
                              · left
                            </span>
                          )}
                          {row.form && row.form.source !== 'own' && (
                            <span
                              style={{ color: 'var(--accent-amber)' }}
                              title={`Only ${row.form.n_results} race${row.form.n_results === 1 ? '' : 's'} of their own, so form is topped up with ${
                                row.form.source === 'pooled' ? "their team-mate's results" : 'the field median'
                              }`}
                            >
                              *
                            </span>
                          )}
                        </span>
                      </Td>
                      <Td>{formatPoints(row.points)}</Td>
                      <Td>{row.gap_to_leader > 0 ? `−${formatPoints(row.gap_to_leader)}` : '—'}</Td>
                      <Td>{formatPoints(row.max_possible)}</Td>
                      <Td>
                        <span style={{ color: row.status === 'clinched' ? 'var(--accent-teal)' : undefined }}>
                          {formatTitleOdds(row.title_probability, row.status, projection.season_complete)}
                        </span>
                      </Td>
                      {scenarioActive && (
                        <Td>
                          <span
                            style={{
                              color:
                                Math.abs(delta) < 0.05
                                  ? 'var(--text-tertiary)'
                                  : delta > 0
                                    ? 'var(--accent-teal)'
                                    : 'var(--accent-red)',
                            }}
                          >
                            {Math.abs(delta) < 0.05 ? '—' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`}
                          </span>
                        </Td>
                      )}
                      <Td>{out && top3 < 0.0005 ? '—' : `${(top3 * 100).toFixed(1)}%`}</Td>
                      <Td align="left">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                          <RangeBar row={row} colour={colour} max={rangeMax} />
                          {formatPoints(Math.round(row.expected_points))}
                          <span style={{ color: 'var(--text-tertiary)' }}>
                            {formatPoints(row.points_p10)}–{formatPoints(row.points_p90)}
                          </span>
                        </span>
                      </Td>
                      {projection.is_backtest && (
                        <Td>
                          {row.actual_points === null
                            ? '—'
                            : `${formatPoints(row.actual_points)} (P${row.actual_position})`}
                        </Td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p style={noteStyle}>
              Max is the most a {mode === 'drivers' ? 'driver' : 'team'} can still reach; once it falls below the
              leader's current total they are out. Title odds and the projected range come from{' '}
              {projection.config.n_sims.toLocaleString()} simulated seasons — see Method below.
              {projection.is_backtest &&
                ` Actual is what really happened by round ${projection.latest_round}, for judging the projection.`}
            </p>
          </div>
        </section>

        {/* ── 2. Trajectory ──────────────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Season Trajectory</h2>
          <div style={{ ...cardStyle, height: 440 }}>
            <Plot
              data={trajectoryTraces}
              layout={{
                autosize: true,
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                font: PLOT_FONT,
                margin: { t: 30, r: 10, b: 90, l: 56 },
                xaxis: xAxis,
                yaxis: { title: { text: 'Points' }, gridcolor: GRID_COLOUR, zeroline: false },
                hovermode: 'closest',
                legend: { orientation: 'h', y: 1.1 },
                ...asOfMarker,
              }}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: '100%', height: '100%' }}
              useResizeHandler
            />
          </div>
          <p style={noteStyle}>
            Solid lines are points scored; dashed lines are the median projection, with the shaded band
            covering 80% of simulated seasons (p10–p90).
            {projection.is_backtest && ' Dotted lines are what actually happened after the as-of round.'}
          </p>
        </section>

        {/* ── 3. Who can still win ───────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Who Can Still Win</h2>
          <div style={{ ...cardStyle, height: 400 }}>
            <Plot
              data={eliminationTraces}
              layout={{
                autosize: true,
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                font: PLOT_FONT,
                margin: { t: 30, r: 10, b: 90, l: 56 },
                xaxis: xAxis,
                yaxis: { title: { text: 'Points behind the leader' }, gridcolor: GRID_COLOUR, zeroline: false },
                hovermode: 'closest',
                legend: { orientation: 'h', y: 1.1 },
                ...asOfMarker,
              }}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: '100%', height: '100%' }}
              useResizeHandler
            />
          </div>
          <p style={noteStyle}>
            The shaded area is the most a {mode === 'drivers' ? 'driver' : 'team'} could still score after each
            round. A line that climbs above it belongs to someone who can no longer catch the leader.
          </p>
        </section>

        {/* ── 4. What if ─────────────────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>What If</h2>
          <div style={cardStyle}>
            {baselineData.remaining.length === 0 ? (
              <p style={{ ...noteStyle, marginTop: 0 }}>No sessions left to run at this point in the season.</p>
            ) : (
              <>
                <p style={{ ...noteStyle, marginTop: 0, marginBottom: 'var(--space-3)' }}>
                  Fix results in sessions still to run, then re-simulate. Every other result is drawn exactly as in
                  the baseline, so any change in the odds is down to the results you set.
                </p>
                {pins.map(pin => (
                  <div
                    key={pin.id}
                    style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}
                  >
                    <select
                      value={pin.session}
                      onChange={e => updatePin(pin.id, { session: e.target.value })}
                      style={selectStyle}
                    >
                      {baselineData.remaining.map(s => (
                        <option key={sessionValue(s)} value={sessionValue(s)}>
                          R{s.round_number} {shortEvent(s.event_name)} · {s.session_type === 'S' ? 'Sprint' : 'Race'}
                        </option>
                      ))}
                    </select>
                    <select
                      value={pin.driver}
                      onChange={e => updatePin(pin.id, { driver: e.target.value })}
                      style={selectStyle}
                    >
                      {gridDrivers.map(d => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <select
                      value={pin.position}
                      onChange={e => updatePin(pin.id, { position: e.target.value })}
                      style={selectStyle}
                    >
                      {positions.map(p => (
                        <option key={p} value={p}>
                          P{p}
                        </option>
                      ))}
                      <option value="DNF">DNF</option>
                    </select>
                    <button
                      onClick={() => setPins(pins.filter(p => p.id !== pin.id))}
                      style={buttonStyle}
                      title="Remove this result"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                  <button onClick={addPin} style={buttonStyle}>
                    <Plus size={12} /> Add result
                  </button>
                  <button
                    onClick={runScenario}
                    disabled={pins.length === 0 || Boolean(currentScenario?.running)}
                    style={{ ...buttonStyle, opacity: pins.length === 0 ? 0.5 : 1 }}
                  >
                    <Play size={12} /> {currentScenario?.running ? 'Simulating…' : 'Run scenario'}
                  </button>
                  <button
                    onClick={resetScenario}
                    disabled={pins.length === 0 && !scenarioActive}
                    style={{ ...buttonStyle, opacity: pins.length === 0 && !scenarioActive ? 0.5 : 1 }}
                  >
                    <RotateCcw size={12} /> Reset
                  </button>
                </div>
                {currentScenario?.error && (
                  <div className="state-error" style={{ marginTop: 'var(--space-3)' }}>
                    {currentScenario.error}
                  </div>
                )}
                {scenarioActive && (
                  <p style={noteStyle}>
                    Showing the scenario throughout the page. The Δ column is the change in title odds against the
                    baseline, in percentage points.
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── 5. Method and caveats ──────────────────────────────── */}
        <section>
          <h2 style={sectionTitleStyle}>Method &amp; Caveats</h2>
          <div style={{ ...cardStyle, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            <p style={{ margin: 0 }}>{projection.method.summary}</p>
            <p style={{ marginTop: 'var(--space-3)' }}>{projection.method.calibration}</p>
            <dl style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <Row label="Simulated seasons">{projection.config.n_sims.toLocaleString()} (seed {projection.config.seed})</Row>
              <Row label="Form">
                last {projection.config.form_window} Grands Prix, ×{projection.config.decay} per race back
              </Row>
              <Row label="Spread">
                race noise σ {projection.config.noise_sd} places · season drift σ {projection.config.drift_sd} places ·
                retirement floor {(projection.config.dnf_floor * 100).toFixed(0)}%
              </Row>
              <Row label="Points per session">
                Race {projection.points_system.race.join('-')}
                {projection.points_system.sprint.length > 0 && ` · Sprint ${projection.points_system.sprint.join('-')}`}
                {projection.points_system.fastest_lap > 0 && ' · +1 fastest lap'}
              </Row>
            </dl>
            <ul style={{ marginTop: 'var(--space-4)', paddingLeft: 'var(--space-4)', color: 'var(--text-tertiary)' }}>
              {projection.method.caveats.map(c => (
                <li key={c} style={{ marginBottom: 'var(--space-1)' }}>
                  {c}
                </li>
              ))}
            </ul>
            {projection.warnings.length > 0 && (
              <div
                style={{
                  marginTop: 'var(--space-4)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--accent-amber)',
                  color: 'var(--text-primary)',
                }}
              >
                {projection.warnings.map(w => (
                  <p key={w} style={{ margin: 0 }}>
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

// ── Data shaping ────────────────────────────────────────────────────

function projectionKey(year: number, asOfRound: number | null, nSims: number, formWindow: number): string {
  return `${year}|${asOfRound ?? 'latest'}|${nSims}|${formWindow}`;
}

function toPin(pin: PinDraft): ChampionshipPin {
  const [round, sessionType] = pin.session.split('|');
  return {
    round_number: Number(round),
    session_type: sessionType === 'S' ? 'S' : 'R',
    driver: pin.driver,
    position: pin.position === 'DNF' ? null : Number(pin.position),
  };
}

function shortEvent(name: string): string {
  return name.replace(/ Grand Prix$/, '');
}

function contendersOf(projection: ChampionshipProjection, mode: Mode): Contender[] {
  return mode === 'drivers'
    ? projection.drivers.map(d => ({ ...d, name: d.driver }))
    : projection.constructors.map(t => ({ ...t, name: t.team }));
}

/** Cumulative points per contender, aligned with the progression's `round_numbers`. */
function seriesOf(progression: ChampionshipProgression, mode: Mode): Map<string, (number | null)[]> {
  return new Map(
    mode === 'drivers'
      ? progression.drivers.map(d => [d.driver, d.cumulative])
      : progression.constructors.map(t => [t.team, t.cumulative])
  );
}

/**
 * One colour per contender. Team-mates share their team's colour, so the lower-placed one is
 * lightened — otherwise two lines on the trajectory chart are indistinguishable.
 */
function colourMap(rows: Contender[], mode: Mode): Map<string, string> {
  const colours = new Map<string, string>();
  const teamsSeen = new Set<string>();
  for (const row of rows) {
    if (mode === 'constructors') {
      colours.set(row.name, getTeamColour(row.name));
      continue;
    }
    const base = getDriverColour(row.name, row.team);
    const team = row.team ?? row.name;
    colours.set(row.name, teamsSeen.has(team) ? adjustColorLightness(base, 25) : base);
    teamsSeen.add(team);
  }
  return colours;
}

/** Points actually held after each round with results, dropping rounds before a debut. */
function actualPoints(progression: ChampionshipProgression, cumulative: (number | null)[]) {
  return progression.round_numbers
    .map((round, i) => ({ round, points: cumulative[i] }))
    .filter((p): p is { round: number; points: number } => p.points !== null && p.points !== undefined);
}

function buildTrajectoryTraces(
  projection: ChampionshipProjection,
  progression: ChampionshipProgression,
  charted: Contender[],
  colours: Map<string, string>,
  series: Map<string, (number | null)[]>,
  labels: Map<number, string>
): Data[] {
  const traces: Data[] = [];
  const label = (round: number) => labels.get(round) ?? `R${round}`;
  const asOf = projection.as_of_round;

  for (const row of charted) {
    const colour = colours.get(row.name) ?? MUTED_COLOUR;
    const actual = actualPoints(progression, series.get(row.name) ?? []);
    const before = actual.filter(p => p.round <= asOf);
    traces.push({
      x: before.map(p => p.round),
      y: before.map(p => p.points),
      text: before.map(p => label(p.round)),
      type: 'scatter',
      mode: 'lines+markers',
      name: row.name,
      legendgroup: row.name,
      line: { color: colour, width: 2 },
      marker: { color: colour, size: 4 },
      hovertemplate: `${row.name} · %{text}<br>%{y} pts<extra></extra>`,
    });

    // In a backtest, what really happened next — joined at the as-of point.
    const after = actual.filter(p => p.round >= asOf);
    if (projection.is_backtest && after.length > 1) {
      traces.push({
        x: after.map(p => p.round),
        y: after.map(p => p.points),
        text: after.map(p => label(p.round)),
        type: 'scatter',
        mode: 'lines',
        legendgroup: row.name,
        showlegend: false,
        opacity: 0.7,
        line: { color: colour, width: 1.5, dash: 'dot' },
        hovertemplate: `${row.name} · %{text}<br>actually %{y} pts<extra></extra>`,
      });
    }

    if (row.trajectory.length === 0) continue;
    // The fan starts from the points held at the as-of point.
    const x = [asOf, ...row.trajectory.map(t => t.round_number)];
    const quantile = (q: 'p10' | 'p50' | 'p90') => [row.points, ...row.trajectory.map(t => t[q])];
    traces.push({
      x,
      y: quantile('p10'),
      type: 'scatter',
      mode: 'lines',
      line: { width: 0, color: colour },
      legendgroup: row.name,
      showlegend: false,
      hoverinfo: 'skip',
    });
    traces.push({
      x,
      y: quantile('p90'),
      type: 'scatter',
      mode: 'lines',
      line: { width: 0, color: colour },
      fill: 'tonexty',
      fillcolor: withAlpha(colour, 0.14),
      legendgroup: row.name,
      showlegend: false,
      hoverinfo: 'skip',
    });
    traces.push({
      x,
      y: quantile('p50'),
      text: x.map(label),
      customdata: [[row.points, row.points], ...row.trajectory.map(t => [t.p10, t.p90])],
      type: 'scatter',
      mode: 'lines',
      legendgroup: row.name,
      showlegend: false,
      line: { color: colour, width: 1.5, dash: 'dash' },
      hovertemplate: `${row.name} · %{text}<br>projected %{y} pts (%{customdata[0]}–%{customdata[1]})<extra></extra>`,
    });
  }
  return traces;
}

function buildEliminationTraces(
  projection: ChampionshipProjection,
  progression: ChampionshipProgression,
  charted: Contender[],
  colours: Map<string, string>,
  series: Map<string, (number | null)[]>,
  labels: Map<number, string>,
  mode: Mode
): Data[] {
  const label = (round: number) => labels.get(round) ?? `R${round}`;
  const rounds = projection.rounds;
  const available = pointsAvailableAfter(projection, mode);
  const traces: Data[] = [
    {
      x: rounds.map(r => r.round_number),
      y: available,
      text: rounds.map(r => label(r.round_number)),
      type: 'scatter',
      mode: 'lines',
      name: 'Points still available',
      line: { color: MUTED_COLOUR, width: 1 },
      fill: 'tozeroy',
      fillcolor: 'rgba(161, 161, 170, 0.08)',
      hovertemplate: 'After %{text}<br>%{y} pts still available<extra></extra>',
    },
  ];

  // The leader at each round is whoever held the most points then, charted or not.
  const everyone = [...series.values()];
  const leader = progression.round_numbers.map((_, i) => Math.max(0, ...everyone.map(c => c[i] ?? 0)));
  for (const row of charted) {
    const colour = colours.get(row.name) ?? MUTED_COLOUR;
    const cumulative = series.get(row.name) ?? [];
    const gaps = progression.round_numbers
      .map((round, i) => ({ round, points: cumulative[i], leader: leader[i] }))
      .filter(p => p.points !== null && p.points !== undefined && p.round <= projection.as_of_round)
      .map(p => ({ round: p.round, gap: p.leader - (p.points ?? 0) }));
    traces.push({
      x: gaps.map(p => p.round),
      y: gaps.map(p => p.gap),
      text: gaps.map(p => label(p.round)),
      type: 'scatter',
      mode: 'lines+markers',
      name: row.name,
      line: { color: colour, width: 2 },
      marker: { color: colour, size: 4 },
      hovertemplate: `${row.name} · %{text}<br>%{y} pts behind<extra></extra>`,
    });
  }
  return traces;
}

/**
 * Most one contender could still score after each round, from the season's points rules —
 * a win (a one-two for a team) in every remaining Grand Prix and Sprint, plus any
 * fastest-lap point. The same arithmetic the backend uses for "who can still win".
 */
function pointsAvailableAfter(projection: ChampionshipProjection, mode: Mode): number[] {
  const { race, sprint, fastest_lap } = projection.points_system;
  const places = mode === 'drivers' ? 1 : 2;
  const best = (table: number[]) => table.slice(0, places).reduce((a, b) => a + b, 0);
  const perRace = best(race) + fastest_lap;
  const perSprint = best(sprint);
  const rounds = projection.rounds;
  return rounds.map((_, i) =>
    rounds.slice(i + 1).reduce((total, r) => total + perRace + (r.has_sprint ? perSprint : 0), 0)
  );
}

// ── Small presentational helpers ────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-secondary)',
};

const noteStyle: React.CSSProperties = {
  marginTop: 'var(--space-3)',
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-tertiary)',
};

const Badge: React.FC<{ colour: string; children: React.ReactNode }> = ({ colour, children }) => (
  <span
    className="badge"
    style={{
      marginLeft: 'var(--space-3)',
      border: `1px solid ${colour}`,
      color: colour,
      verticalAlign: 'middle',
    }}
  >
    {children}
  </span>
);

/** p10–p90 of the projected final total as a bar, with a tick at the mean. */
const RangeBar: React.FC<{ row: Contender; colour: string; max: number }> = ({ row, colour, max }) => {
  const width = 120;
  const x = (points: number) => (points / max) * width;
  return (
    <svg width={width} height={10} style={{ display: 'block' }}>
      <rect x={0} y={4} width={width} height={2} fill="var(--bg-raised)" />
      <rect
        x={x(row.points_p10)}
        y={2}
        width={Math.max(x(row.points_p90) - x(row.points_p10), 2)}
        height={6}
        rx={2}
        fill={withAlpha(colour, 0.45)}
      />
      <rect x={x(row.expected_points) - 1} y={0} width={2} height={10} fill={colour} />
    </svg>
  );
};

const Th: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({ children, align = 'right' }) => (
  <th style={{ padding: 'var(--space-1) var(--space-2)', textAlign: align, fontWeight: 500 }}>{children}</th>
);

const Td: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({ children, align = 'right' }) => (
  <td style={{ padding: 'var(--space-1) var(--space-2)', textAlign: align, whiteSpace: 'nowrap' }}>{children}</td>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
    <dt style={{ minWidth: 150, color: 'var(--text-tertiary)' }}>{label}</dt>
    <dd style={{ margin: 0, flex: 1 }}>{children}</dd>
  </div>
);

export default ChampionshipPage;
