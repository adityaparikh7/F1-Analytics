/**
 * Race Replay — the replay itself, once a race's payload has loaded (see RaceReplayPage).
 *
 * Layout:
 *   header    title, track status banner, weather at the current moment
 *   row 1     map card (toolbar · Map / Follow / 3D view · timeline) and the side card
 *             (Standings or Relative timing)
 *   row 2     gap chart (head-to-head when a rival is picked) · race events · driver telemetry
 *
 * Selection: click a car (map, tower or event) to follow it; shift-click a second car to compare
 * the two; Esc clears the rival, then the focus. Keyboard shortcuts are listed under "?".
 *
 * Mounted with `key={sessionKey}`, so a new race starts with a fresh clock and selection.
 */

import React, { lazy, Suspense, useEffect, useMemo, useReducer } from 'react';
import { Video, X } from 'lucide-react';
import { getCompoundColour, getTrackStatusColour } from '../lib/colours';
import { DriverHud } from './DriverHud';
import { ErrorBoundary } from './ErrorBoundary';
import { EventFeed } from './EventFeed';
import { GapChart } from './GapChart';
import { HeadToHead } from './HeadToHead';
import { HudReadouts } from './HudReadouts';
import { MapToolbar } from './MapToolbar';
import { PlaybackBar } from './PlaybackBar';
import type { TimelineMarker } from './PlaybackBar';
import { RelativeTower } from './RelativeTower';
import { ReplayTrack } from './ReplayTrack';
import { ShortcutHelp } from './ShortcutHelp';
import { TimingTower } from './TimingTower';
import { TrackStrip } from './TrackStrip';
import { WeatherChip } from './WeatherChip';
import type { Replay } from './decode';
import type { ReplayStart } from './links';
import { battlesAt, computeStandings, leaderLapEnds, redFlagSkips, trackStatusAt } from './replayMath';
import { cardStyle, cardTitleStyle, iconButtonStyle, replayPageStyle as pageStyle, toggleStyle } from './styles';
import { buildGeometry } from './trackGeometry';
import type { UiState } from './uiState';
import { initialUiState, persistUiState, uiReducer, ZOOM_LEVELS } from './uiState';
import { useDirector } from './useDirector';
import { useDriverHud } from './useDriverHud';
import { useRaceMoments } from './useRaceMoments';
import { useElementSize } from './useElementSize';
import { usePlaybackClock } from './usePlaybackClock';
import { useReplayWeather } from './weather';

const NO_BATTLES = new Set<string>();

// three.js (~250 KB gzipped) only downloads when the 3D view is first opened.
const Replay3DView = lazy(() => import('./three/Replay3DView'));

const STATUS_BANNERS: Record<string, string> = {
  sc: 'Safety car',
  vsc: 'Virtual safety car',
  vsc_ending: 'VSC ending',
  red: 'Red flag',
  yellow: 'Yellow flag',
};

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

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Back / forward 30 s (Shift: 2 min)'],
  ['V', 'Next view: map, follow, 3D'],
  ['C', 'Next 3D camera'],
  ['H', 'Heading-up (follow view)'],
  ['− / =', 'Zoom out / in (follow view)'],
  ['[ / ]', 'Follow the car ahead / behind'],
  ['Click · Shift-click', 'Follow a car · compare with it'],
  ['D', 'Director: auto-follow the action'],
  ['R', 'Standings / relative timing'],
  ['L / B', 'Driver labels / battle highlights'],
  ['Esc', 'Clear the comparison, then the focus'],
];

/** Where a deep link starts playback: just before the leader begins `lap`. */
function startTime(replay: Replay, lap: number | null): number {
  if (lap == null) return replay.tStart;
  if (lap <= 1) return Math.max(replay.tStart, replay.raceStart - 5);
  const prev = leaderLapEnds(replay).find(l => l.lap === lap - 1);
  return prev ? Math.max(replay.tStart, prev.t - 3) : replay.tStart;
}

function isTyping(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

export const ReplayView: React.FC<{ replay: Replay; sessionKey: string; start: ReplayStart | null }> = ({
  replay,
  sessionKey,
  start,
}) => {
  const linked = start != null && (start.lap != null || start.driver != null);
  const [ui, dispatch] = useReducer(
    uiReducer,
    start?.driver && replay.byAbbr.has(start.driver) ? start.driver : null,
    initialUiState
  );
  const [mapRef, mapSize] = useElementSize<HTMLDivElement>();

  useEffect(() => persistUiState(ui), [ui]);

  const redSkips = useMemo(() => redFlagSkips(replay), [replay]);
  // A linked moment starts playing at 2× so it can be watched; otherwise wait on the grid at 5×.
  const clock = usePlaybackClock({
    tMin: replay.tStart,
    tMax: replay.tEnd,
    initial: startTime(replay, start?.lap ?? null),
    initialSpeed: linked ? 2 : 5,
    autoplay: linked,
    skips: ui.skipRed ? redSkips : undefined,
  });
  const { time, toggle, nudge, seek } = clock;

  const weather = useReplayWeather(sessionKey);
  const moments = useRaceMoments(sessionKey);
  const geometry = useMemo(() => buildGeometry(replay), [replay]);
  const lapTicks = useMemo(() => leaderLapEnds(replay), [replay]);
  const rows = useMemo(() => computeStandings(replay, time), [replay, time]);
  const battles = useMemo(() => (ui.battles ? battlesAt(rows) : NO_BATTLES), [rows, ui.battles]);
  const trackStatus = trackStatusAt(replay, time);
  const leaderLap = time < replay.raceStart ? 1 : (rows[0]?.lap ?? 1);
  const chequered = replay.finishT != null && time >= replay.finishT;

  // With the director on, it decides who is followed; picking a car by hand switches it off.
  const directorPick = useDirector(replay, clock.subscribe, ui.director);
  const focus = ui.director ? (directorPick?.focus ?? null) : ui.focus;
  const rival = ui.director ? null : ui.rival;

  const markers = useMemo<TimelineMarker[]>(() => {
    const drv = focus ? replay.byAbbr.get(focus) : undefined;
    if (!drv) return [];
    return drv.stops.map(s => ({
      t: s.in_t,
      colour: getCompoundColour(drv.laps.get(s.lap + 1)?.compound),
      label: `${drv.abbr} pit stop, lap ${s.lap}`,
    }));
  }, [replay, focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const set = (patch: Partial<UiState>) => dispatch({ type: 'set', patch });
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        nudge((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 120 : 30));
      } else if (e.key === 'Escape') {
        dispatch({ type: 'escape' });
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
      } else if (e.key === 'd' || e.key === 'D') {
        set({ director: !ui.director });
      } else if (e.key === 'r' || e.key === 'R') {
        set({ sideTab: ui.sideTab === 'standings' ? 'relative' : 'standings' });
      } else if (e.key === 'l' || e.key === 'L') {
        set({ labels: !ui.labels });
      } else if (e.key === 'b' || e.key === 'B') {
        set({ battles: !ui.battles });
      } else if (e.key === '?') {
        set({ help: !ui.help });
      } else if (e.key === '[' || e.key === ']') {
        const idx = rows.findIndex(r => r.driver.abbr === focus);
        const target = idx < 0 ? rows[0] : rows[idx + (e.key === '[' ? -1 : 1)];
        if (target && target.driver.abbr !== focus) dispatch({ type: 'select', abbr: target.driver.abbr, shift: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, nudge, rows, focus, ui.headingUp, ui.director, ui.sideTab, ui.labels, ui.battles, ui.help]);

  const select = (abbr: string, shift = false) => dispatch({ type: 'select', abbr, shift });
  const seekTo = (t: number, abbr?: string | null, rivalAbbr?: string | null) => {
    seek(t);
    if (abbr && replay.byAbbr.has(abbr)) {
      dispatch({ type: 'follow', abbr, rival: rivalAbbr && replay.byAbbr.has(rivalAbbr) ? rivalAbbr : null });
    }
  };

  let banner: { text: string; colour: string } | null = null;
  if (time < replay.raceStart) banner = { text: 'On the grid', colour: 'var(--text-secondary)' };
  else if (chequered) banner = { text: 'Chequered flag', colour: 'var(--text-primary)' };
  else if (trackStatus && STATUS_BANNERS[trackStatus.kind])
    banner = { text: STATUS_BANNERS[trackStatus.kind], colour: getTrackStatusColour(trackStatus.kind) };

  const followAbbr = focus;
  const trackProps = {
    replay,
    geometry,
    subscribe: clock.subscribe,
    focus,
    rival,
    battles,
    statusKind: trackStatus?.kind,
    onSelect: select,
  };

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ fontSize: 'var(--fs-2xl)' }}>Race Replay</h1>
          <div className="text-secondary" style={{ fontSize: 'var(--fs-md)' }}>
            {replay.eventName} {sessionKey.slice(0, 4)} — {replay.sessionName}
          </div>
        </div>
        {banner && (
          <span
            style={{
              padding: '4px 12px',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${banner.colour}`,
              color: banner.colour,
              fontWeight: 700,
              fontSize: 'var(--fs-sm)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {banner.text}
          </span>
        )}
        <WeatherChip weather={weather} time={time} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...cardStyle, flex: '1 1 560px', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <MapToolbar state={ui} dispatch={dispatch} hasElevation={replay.elevation != null} />
          <div ref={mapRef} style={{ height: 'clamp(340px, 56vh, 640px)', minWidth: 0, position: 'relative' }}>
            {mapSize.width > 0 && ui.view !== '3d' && (
              <ReplayTrack
                {...trackProps}
                width={mapSize.width}
                height={mapSize.height}
                mode={ui.view === 'follow' ? 'follow' : 'fit'}
                followAbbr={followAbbr}
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
                    rival={rival}
                    battles={battles}
                    camera={ui.camera}
                    elevation={ui.elevation}
                    labels={ui.labels}
                    statusKind={trackStatus?.kind ?? null}
                    speed={clock.speed}
                    onSelect={select}
                  />
                </Suspense>
                {!replay.elevation && (
                  <span style={overlayNoteStyle}>
                    {replay.version < 2 ? 'Flat track — this replay is being rebuilt with elevation' : 'Flat track (no elevation data)'}
                  </span>
                )}
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
            {ui.view !== 'map' && !focus && !ui.director && (
              <span style={overlayNoteStyle}>Following the leader — click a car to follow it</span>
            )}
            {ui.director && directorPick && (
              <span
                style={{ ...overlayNoteStyle, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)' }}
                title="The director follows the action; click any car to take over (D toggles)"
              >
                <Video size={12} />
                {directorPick.caption}
              </span>
            )}
            {ui.help && <ShortcutHelp items={SHORTCUTS} onClose={() => dispatch({ type: 'set', patch: { help: false } })} />}
          </div>
          {focus && mapSize.width > 0 && (
            <TrackStrip
              replay={replay}
              geometry={geometry}
              subscribe={clock.subscribe}
              focus={focus}
              rival={rival}
              width={mapSize.width}
            />
          )}
          <PlaybackBar
            replay={replay}
            clock={clock}
            lapTicks={lapTicks}
            leaderLap={leaderLap}
            hasRedFlags={redSkips.length > 0}
            skipRed={ui.skipRed}
            onSkipRedChange={skipRed => dispatch({ type: 'set', patch: { skipRed } })}
            markers={markers}
            rain={weather?.rain}
          />
        </div>

        <div style={{ ...cardStyle, flex: '0 1 340px', minWidth: 290, padding: 'var(--space-3) 0' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
              padding: '0 var(--space-3) var(--space-2)',
            }}
          >
            <div style={{ display: 'flex', gap: 2 }} role="tablist">
              <button style={toggleStyle(ui.sideTab === 'standings')} onClick={() => dispatch({ type: 'set', patch: { sideTab: 'standings' } })}>
                Standings
              </button>
              <button
                style={toggleStyle(ui.sideTab === 'relative')}
                onClick={() => dispatch({ type: 'set', patch: { sideTab: 'relative' } })}
                title="Cars physically nearest the followed driver on track (R)"
              >
                Relative
              </button>
            </div>
            <span className="mono" style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
              LAP {leaderLap}/{replay.totalLaps}
            </span>
          </div>
          {ui.sideTab === 'standings' ? (
            <>
              <div style={{ display: 'flex', gap: 4, padding: '0 var(--space-3) var(--space-2)' }}>
                <button style={toggleStyle(ui.gapMode === 'interval')} onClick={() => dispatch({ type: 'set', patch: { gapMode: 'interval' } })}>
                  Interval
                </button>
                <button style={toggleStyle(ui.gapMode === 'leader')} onClick={() => dispatch({ type: 'set', patch: { gapMode: 'leader' } })}>
                  Leader
                </button>
              </div>
              <TimingTower rows={rows} mode={ui.gapMode} focus={focus} rival={rival} battles={battles} onSelect={select} />
            </>
          ) : (
            <RelativeTower replay={replay} rows={rows} time={time} focus={focus} rival={rival} onSelect={select} />
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...cardStyle, flex: '1.4 1 420px' }}>
          <div style={cardTitleStyle}>{focus && rival ? 'Head to head' : 'Gap to leader'}</div>
          {focus && rival ? (
            <HeadToHead replay={replay} a={focus} b={rival} time={time} lapTicks={lapTicks} onSeek={seek} height={240} />
          ) : (
            <GapChart replay={replay} time={time} lapTicks={lapTicks} focus={focus} onSeek={seek} height={260} />
          )}
        </div>
        <div style={{ ...cardStyle, flex: '1 1 320px' }}>
          <div style={cardTitleStyle}>Race events</div>
          <EventFeed
            replay={replay}
            geometry={geometry}
            moments={moments}
            weather={weather}
            time={time}
            onSeek={seekTo}
            height={262}
          />
        </div>
        <div style={{ ...cardStyle, flex: '0.8 1 280px' }}>
          <div style={cardTitleStyle}>{focus && rival ? 'Drivers' : 'Driver'}</div>
          {focus && rival ? (
            <CompareHuds
              sessionKey={sessionKey}
              replay={replay}
              subscribe={clock.subscribe}
              drivers={[focus, rival]}
              onClear={() => dispatch({ type: 'escape' })}
            />
          ) : focus ? (
            <DriverHud
              sessionKey={sessionKey}
              replay={replay}
              subscribe={clock.subscribe}
              abbr={focus}
              rows={rows}
              onClose={() => dispatch({ type: 'escape' })}
            />
          ) : (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>
              Click a car on the map or a row in the timing tower to follow a driver: live speed, gear, RPM,
              throttle and brake, and the gaps either side. Shift-click a second car to compare the two.
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', maxWidth: 900, lineHeight: 1.6 }}>
        Positions are FastF1 GPS samples (about 4 per second) drawn as recorded. Order and gaps between timing
        lines come from each car's distance along the racing line, anchored to the official line crossings, so they
        can differ from the live timing by a place during pit stops. The order shown at the flag is the order on the
        road; post-race penalties are not applied. From a red flag until the leader completes the first lap after
        the restart, the order and gaps are held at the moment the flag came out.
      </div>
    </div>
  );
};

const CompareColumn: React.FC<{
  sessionKey: string;
  replay: Replay;
  subscribe: (cb: (t: number) => void) => () => void;
  abbr: string;
}> = ({ sessionKey, replay, subscribe, abbr }) => {
  const { hud, error } = useDriverHud(sessionKey, abbr, replay.version);
  const drv = replay.byAbbr.get(abbr);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-2)', fontWeight: 700 }}>
        <span style={{ width: 4, height: 16, borderRadius: 2, background: drv?.colour }} />
        {abbr}
      </div>
      {error ? (
        <div className="text-secondary" style={{ fontSize: 'var(--fs-xs)' }}>
          Telemetry unavailable
        </div>
      ) : hud ? (
        <HudReadouts replay={replay} hud={hud} subscribe={subscribe} compact />
      ) : (
        <div className="skeleton skeleton--bar" />
      )}
    </div>
  );
};

/** Two drivers' live telemetry side by side, for head-to-head. */
const CompareHuds: React.FC<{
  sessionKey: string;
  replay: Replay;
  subscribe: (cb: (t: number) => void) => () => void;
  drivers: [string, string];
  onClear: () => void;
}> = ({ drivers, onClear, ...rest }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
    <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
      {drivers.map(abbr => (
        <CompareColumn key={abbr} abbr={abbr} {...rest} />
      ))}
    </div>
    <button style={{ ...iconButtonStyle, width: 'auto', padding: '0 8px', alignSelf: 'flex-start' }} onClick={onClear}>
      <X size={12} /> Stop comparing
    </button>
  </div>
);
