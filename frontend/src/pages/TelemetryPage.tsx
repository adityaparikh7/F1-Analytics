/**
 * Telemetry — compare laps on the replay engine.
 *
 * Pick up to four laps from the active session (any session type); the first is the reference.
 * Each lap becomes a car in a synthetic replay (`replay/lapReplay.ts`) that starts at the line at
 * t = 0, so the laps race each other on the 2D map, the follow cam or the 3D track, at anything
 * from 0.1× to 4×. Alongside: a timing board with the live gap at the same point of the lap,
 * minisector dominance drawn on the map, and distance charts (delta, speed, throttle, brake,
 * gear, RPM) whose cursors follow playback.
 *
 * Lap traces come from `GET /sessions/{key}/lap-trace` (FastF1, cached per session on the
 * backend), fetched as laps are picked.
 */

import React, { lazy, Suspense, useEffect, useMemo, useReducer, useState } from 'react';
import { Layers } from 'lucide-react';
import { api } from '../lib/api';
import type { LapData } from '../lib/api';
import { colourVariant, getDriverColour } from '../lib/colours';
import { formatSessionType } from '../lib/format';
import { ErrorBoundary } from '../replay/ErrorBoundary';
import type { CompareLap, LapComparison } from '../replay/lapReplay';
import { buildLapComparison } from '../replay/lapReplay';
import { MapToolbar } from '../replay/MapToolbar';
import type { TrackOverlay } from '../replay/ReplayTrack';
import { ReplayTrack } from '../replay/ReplayTrack';
import { ShortcutHelp } from '../replay/ShortcutHelp';
import { cardStyle, cardTitleStyle, replayPageStyle as pageStyle, toggleStyle } from '../replay/styles';
import { buildGeometry } from '../replay/trackGeometry';
import { initialUiState, persistUiState, uiReducer, ZOOM_LEVELS } from '../replay/uiState';
import type { UiState } from '../replay/uiState';
import { useElementSize } from '../replay/useElementSize';
import { usePlaybackClock } from '../replay/usePlaybackClock';
import { useSessionStore } from '../store/sessionStore';
import { LapBoard } from '../telemetry/LapBoard';
import { LapPicker } from '../telemetry/LapPicker';
import { LapTransport } from '../telemetry/LapTransport';
import { bestLaps } from '../telemetry/lapUtils';
import { TelemetryCharts } from '../telemetry/TelemetryCharts';
import { dominanceOverlays, minisectorDominance, MINISECTORS, pathBetween } from '../telemetry/trackOverlays';
import type { LapSpec } from '../telemetry/useLapTraces';
import { lapKey, useLapTraces } from '../telemetry/useLapTraces';

// three.js only downloads when the 3D view is first opened (shared with the race replay).
const Replay3DView = lazy(() => import('../replay/three/Replay3DView'));

const VIEW_STORAGE_KEY = 'pitwall_telemetry_view';
const NO_BATTLES = new Set<string>();

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Back / forward 1 s (Shift: 0.1 s)'],
  ['1 – 4', 'Follow that lap'],
  ['[ / ]', 'Follow the previous / next lap'],
  ['V', 'Next view: map, follow, 3D'],
  ['C', 'Next 3D camera'],
  ['H', 'Heading-up (follow view)'],
  ['− / =', 'Zoom out / in (follow view)'],
  ['M', 'Minisector dominance on the map'],
  ['L', 'Lap labels'],
  ['Esc', 'Reset the chart zoom'],
];

const overlayNoteStyle: React.CSSProperties = {
  position: 'absolute',
  left: 8,
  top: 8,
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-secondary)',
  background: 'var(--bg-panel)',
  padding: '2px 8px',
  borderRadius: 'var(--radius-sm)',
  pointerEvents: 'none',
};

const mapHeight = 'clamp(340px, 54vh, 620px)';

/** Beside the map: the timing board above the picker; below the map on narrow screens, side by side. */
const sideColumnStyle: React.CSSProperties = {
  flex: '1 1 380px',
  minWidth: 320,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  alignContent: 'flex-start',
  gap: 'var(--space-4)',
};

function isTyping(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

/** One colour per selected lap: the team colour, a lighter or darker shade for repeats. */
function lapColours(specs: LapSpec[], teams: Map<string, string | null>): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const s of specs) {
    const base = getDriverColour(s.driver, teams.get(s.driver));
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    out.set(lapKey(s), colourVariant(base, k));
  }
  return out;
}

interface Keyed<T> {
  key: string;
  data?: T;
  error?: string;
}

const TelemetryPage: React.FC = () => {
  const { activeSessionKey, activeSession } = useSessionStore();
  const sessionKey = activeSessionKey ?? '';
  const [lapsState, setLapsState] = useState<Keyed<LapData[]> | null>(null);
  const [selection, setSelection] = useState<{ session: string; specs: LapSpec[] } | null>(null);

  useEffect(() => {
    if (!activeSessionKey) return;
    const key = activeSessionKey;
    let cancelled = false;
    api
      .getLaps(key)
      .then(data => !cancelled && setLapsState({ key, data }))
      .catch((err: Error) => !cancelled && setLapsState({ key, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [activeSessionKey]);

  const current = lapsState?.key === sessionKey ? lapsState : null;
  const laps = current?.data;

  // Until the user picks, compare the two fastest drivers' best laps.
  const defaults = useMemo<LapSpec[]>(
    () => (laps ? bestLaps(laps).slice(0, 2).map(b => ({ driver: b.driver, lap: b.best.lap_number })) : []),
    [laps]
  );
  const specs = selection?.session === sessionKey ? selection.specs : defaults;
  const teams = useMemo(() => new Map((laps ?? []).map(l => [l.driver, l.team])), [laps]);
  const colours = useMemo(() => lapColours(specs, teams), [specs, teams]);

  const store = useLapTraces(sessionKey, specs);
  const loadingKeys = useMemo(
    () => new Set(specs.map(lapKey).filter(k => !store.traces.has(k) && !store.errors.has(k))),
    [specs, store]
  );
  const loadedKeys = specs.map(lapKey).filter(k => store.traces.has(k));
  const readyId = loadingKeys.size === 0 && loadedKeys.length > 0 ? loadedKeys.join('|') : '';

  const meta = useMemo(
    () => ({
      sessionKey,
      eventName: activeSession?.event_name ?? '',
      sessionName: activeSession ? formatSessionType(activeSession.session_type) : '',
    }),
    [sessionKey, activeSession]
  );

  const comparison = useMemo<LapComparison | null>(() => {
    if (!readyId) return null;
    const compared: CompareLap[] = readyId.split('|').map(key => ({
      key,
      colour: colours.get(key) ?? 'var(--text-secondary)',
      trace: store.traces.get(key)!,
    }));
    return buildLapComparison(compared, meta);
  }, [readyId, colours, store.traces, meta]);

  // While a newly picked lap loads, keep showing the comparison already on screen.
  const [shown, setShown] = useState<LapComparison | null>(null);
  if (comparison && comparison !== shown) setShown(comparison);
  const display =
    comparison ??
    (shown && shown.replay.sessionKey === sessionKey && loadingKeys.size > 0 ? shown : null);

  if (!activeSessionKey) {
    return <div className="state-empty">Select a session to compare laps</div>;
  }
  if (current?.error) {
    return <div className="state-error">Couldn't load laps. {current.error.replace(/^API Error \d+: /, '')}</div>;
  }

  const picker = laps ? (
    <LapPicker
      laps={laps}
      selected={specs}
      colours={colours}
      loading={loadingKeys}
      errors={store.errors}
      onChange={next => setSelection({ session: sessionKey, specs: next })}
    />
  ) : (
    <div className="state-loading" style={{ padding: 0 }}>
      <div className="skeleton skeleton--bar" style={{ width: '100%' }} />
      <div className="skeleton skeleton--bar" style={{ width: '100%' }} />
    </div>
  );

  const errorNotes = specs
    .map(lapKey)
    .filter(k => store.errors.has(k))
    .map(k => `${k}: ${store.errors.get(k)}`);
  const loadingNote = loadingKeys.size > 0 ? `Loading telemetry for ${[...loadingKeys].join(', ')}…` : null;

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ fontSize: 'var(--fs-2xl)' }}>Telemetry</h1>
          <div className="text-secondary" style={{ fontSize: 'var(--fs-md)' }}>
            {activeSession?.event_name} {activeSession?.year} — {activeSession ? formatSessionType(activeSession.session_type) : ''}
          </div>
        </div>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
          Up to four laps · the first is the reference
        </span>
      </div>

      {errorNotes.length > 0 && (
        <div className="state-error" style={{ padding: 'var(--space-2) var(--space-3)', alignItems: 'flex-start', textAlign: 'left' }}>
          {errorNotes.map(n => (
            <div key={n}>Couldn't load {n}</div>
          ))}
        </div>
      )}

      {display ? (
        <LapView key={display.laps.map(l => `${l.key}=${l.colour}`).join('|')} comparison={display} picker={picker} note={loadingNote} />
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ ...cardStyle, flex: '3 1 560px', height: mapHeight, display: 'flex' }}>
            {loadingNote || !laps ? (
              <div className="state-loading" style={{ flex: 1 }}>
                {loadingNote ?? 'Loading laps…'}
              </div>
            ) : (
              <div className="state-empty" style={{ flex: 1 }}>
                Pick a lap to start
              </div>
            )}
          </div>
          <div style={sideColumnStyle}>
            <div style={{ ...cardStyle, flex: '1 1 340px' }}>{picker}</div>
          </div>
        </div>
      )}
    </div>
  );
};

/** One comparison: the map, playback, timing board and charts, on their own clock. */
const LapView: React.FC<{ comparison: LapComparison; picker: React.ReactNode; note: string | null }> = ({
  comparison,
  picker,
  note,
}) => {
  const { replay, laps } = comparison;
  const refKey = laps[0].key;
  const [ui, dispatch] = useReducer(uiReducer, refKey, focus => initialUiState(focus, VIEW_STORAGE_KEY));
  const [mapRef, mapSize] = useElementSize<HTMLDivElement>();
  const [dominance, setDominance] = useState(true);
  const [range, setRange] = useState<[number, number] | null>(null);

  useEffect(() => persistUiState(ui, VIEW_STORAGE_KEY), [ui]);

  const clock = usePlaybackClock({ tMin: replay.tStart, tMax: replay.tEnd, initialSpeed: 1 });
  const { toggle, nudge, seek } = clock;
  const geometry = useMemo(() => buildGeometry(replay), [replay]);
  const focus = ui.focus && replay.byAbbr.has(ui.focus) ? ui.focus : refKey;
  const follow = (abbr: string) => dispatch({ type: 'follow', abbr });

  const minisectors = useMemo(() => minisectorDominance(comparison), [comparison]);
  const wins = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of minisectors) counts.set(m.fastest, (counts.get(m.fastest) ?? 0) + 1);
    return counts;
  }, [minisectors]);
  const showDominance = dominance && laps.length > 1;

  const overlays = useMemo(() => {
    const out: TrackOverlay[] = [];
    if (range) {
      out.push({
        points: pathBetween(comparison, range[0], range[1]),
        colour: 'var(--text-primary)',
        width: 16,
        opacity: 0.18,
        title: 'Shown in the charts',
      });
    }
    if (showDominance) out.push(...dominanceOverlays(comparison, minisectors));
    return out;
  }, [comparison, minisectors, showDominance, range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const set = (patch: Partial<UiState>) => dispatch({ type: 'set', patch });
      const idx = laps.findIndex(l => l.key === focus);
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        nudge((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 1));
      } else if (/^[1-4]$/.test(e.key) && laps[Number(e.key) - 1]) {
        dispatch({ type: 'follow', abbr: laps[Number(e.key) - 1].key });
      } else if (e.key === '[' || e.key === ']') {
        const next = laps[(idx + (e.key === '[' ? -1 : 1) + laps.length) % laps.length];
        dispatch({ type: 'follow', abbr: next.key });
      } else if (e.key === 'Escape') {
        if (ui.help) set({ help: false });
        else setRange(null);
      } else if (e.key === 'v' || e.key === 'V') {
        dispatch({ type: 'cycleView' });
      } else if (e.key === 'c' || e.key === 'C') {
        dispatch({ type: 'cycleCamera' });
      } else if (e.key === 'h' || e.key === 'H') {
        set({ headingUp: !ui.headingUp });
      } else if (e.key === '-' || e.key === '_') {
        dispatch({ type: 'zoom', step: 1 });
      } else if (e.key === '=' || e.key === '+') {
        dispatch({ type: 'zoom', step: -1 });
      } else if (e.key === 'm' || e.key === 'M') {
        setDominance(v => !v);
      } else if (e.key === 'l' || e.key === 'L') {
        set({ labels: !ui.labels });
      } else if (e.key === '?') {
        set({ help: !ui.help });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, nudge, laps, focus, ui.help, ui.headingUp, ui.labels]);

  const trackProps = {
    replay,
    geometry,
    subscribe: clock.subscribe,
    focus,
    rival: null,
    battles: NO_BATTLES,
    statusKind: null,
    overlays,
    onSelect: follow,
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ ...cardStyle, flex: '3 1 560px', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <MapToolbar
            state={ui}
            dispatch={dispatch}
            hasElevation={replay.elevation != null}
            showDirector={false}
            showBattles={false}
            extra={
              laps.length > 1 && ui.view !== '3d' ? (
                <button
                  style={{ ...toggleStyle(dominance), height: 28 }}
                  onClick={() => setDominance(v => !v)}
                  aria-pressed={dominance}
                  title={`Colour the track by the lap that was fastest through each of ${MINISECTORS} minisectors (M)`}
                >
                  <Layers size={14} />
                  Dominance
                </button>
              ) : null
            }
          />
          <div ref={mapRef} style={{ height: mapHeight, minWidth: 0, position: 'relative' }}>
            {mapSize.width > 0 && ui.view !== '3d' && (
              <ReplayTrack
                {...trackProps}
                width={mapSize.width}
                height={mapSize.height}
                mode={ui.view === 'follow' ? 'follow' : 'fit'}
                followAbbr={focus}
                headingUp={ui.headingUp}
                zoomWindow={ZOOM_LEVELS[ui.zoomIndex]}
                showLabels={ui.labels}
              />
            )}
            {mapSize.width > 0 && ui.view === '3d' && (
              <ErrorBoundary
                fallback={error => (
                  <>
                    <ReplayTrack {...trackProps} width={mapSize.width} height={mapSize.height} showLabels={ui.labels} />
                    <span style={overlayNoteStyle}>3D view unavailable ({error.message}) — showing the map</span>
                  </>
                )}
              >
                <Suspense fallback={<div className="state-loading" style={{ height: '100%' }}>Loading 3D view…</div>}>
                  <Replay3DView
                    replay={replay}
                    geometry={geometry}
                    subscribe={clock.subscribe}
                    focus={focus}
                    rival={null}
                    battles={NO_BATTLES}
                    camera={ui.camera}
                    elevation={ui.elevation}
                    labels={ui.labels}
                    statusKind={null}
                    speed={clock.speed}
                    onSelect={follow}
                  />
                </Suspense>
                {!replay.elevation && <span style={overlayNoteStyle}>Flat track (no elevation data)</span>}
              </ErrorBoundary>
            )}
            {ui.view === 'follow' && mapSize.width > 0 && (
              <div
                style={{
                  position: 'absolute',
                  right: 8,
                  bottom: 8,
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  opacity: 0.92,
                }}
              >
                <ReplayTrack {...trackProps} width={170} height={115} showLabels={false} showCorners={false} carRadius={3} />
              </div>
            )}
            {note && <span style={overlayNoteStyle}>{note}</span>}
            {showDominance && ui.view === 'map' && (
              <div
                style={{
                  position: 'absolute',
                  left: 8,
                  bottom: 8,
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  fontSize: 'var(--fs-xs)',
                  background: 'var(--bg-panel)',
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                }}
                title={`Each lap's share of the ${MINISECTORS} minisectors it was fastest through`}
              >
                <span className="text-tertiary">Fastest minisectors</span>
                {laps.map(l => (
                  <span key={l.key} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 4, borderRadius: 2, background: l.colour }} />
                    {l.key} <b>{wins.get(l.key) ?? 0}</b>
                  </span>
                ))}
              </div>
            )}
            {ui.help && <ShortcutHelp items={SHORTCUTS} onClose={() => dispatch({ type: 'set', patch: { help: false } })} />}
          </div>
          <LapTransport comparison={comparison} clock={clock} />
        </div>

        <div style={sideColumnStyle}>
          <div style={{ ...cardStyle, flex: '1 1 340px', padding: 'var(--space-3) 0 0' }}>
            <div style={{ ...cardTitleStyle, padding: '0 var(--space-3)' }}>Laps</div>
            <LapBoard comparison={comparison} subscribe={clock.subscribe} focus={focus} onFocus={follow} />
          </div>
          <div style={{ ...cardStyle, flex: '1 1 340px' }}>{picker}</div>
        </div>
      </div>

      <div style={cardStyle}>
        <TelemetryCharts
          comparison={comparison}
          subscribe={clock.subscribe}
          focus={focus}
          onSeek={seek}
          range={range}
          onRangeChange={setRange}
        />
      </div>
    </>
  );
};

export default TelemetryPage;
