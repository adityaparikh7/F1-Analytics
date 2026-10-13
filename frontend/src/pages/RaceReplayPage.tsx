/**
 * Race Replay — in-depth page.
 *
 * Rewatch a race or sprint from FastF1's GPS position data: every car on the track map, a
 * live timing tower, and the race's events in sync. Sections:
 *   1. Track map + transport   cars at their real positions; timeline with SC/VSC/red bands
 *   2. Timing tower            order, interval or gap to leader, tyre, stops, pit/out/finish
 *   3. Gap chart               gap to the leader at the line, building lap by lap
 *   4. Event feed              race control, pit stops and retirements as they happen
 *   5. Driver HUD              click a car: speed, gear, throttle, brake, DRS, gaps either side
 *
 * Reached from the Topbar's Replay button, or from a moment in the Race Moments panel, which
 * links here as `?session=…&lap=…&driver=…` (see `replay/links.ts`) to start at that lap
 * following that driver. The first visit to a race builds its replay on the backend (seconds
 * from a warm FastF1 cache).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ReplayStatus } from '../lib/api';
import { getCompoundColour, getTrackStatusColour } from '../lib/colours';
import { DriverHud } from '../replay/DriverHud';
import { EventFeed } from '../replay/EventFeed';
import { GapChart } from '../replay/GapChart';
import { PlaybackBar } from '../replay/PlaybackBar';
import type { TimelineMarker } from '../replay/PlaybackBar';
import { ReplayTrack } from '../replay/ReplayTrack';
import { TimingTower } from '../replay/TimingTower';
import type { GapMode } from '../replay/TimingTower';
import type { Replay } from '../replay/decode';
import { decodeReplay } from '../replay/decode';
import type { ReplayStart } from '../replay/links';
import { readReplayParams } from '../replay/links';
import { battlesAt, computeStandings, leaderLapEnds, redFlagSkips, trackStatusAt } from '../replay/replayMath';
import { cardStyle, cardTitleStyle, toggleStyle } from '../replay/styles';
import { useElementSize } from '../replay/useElementSize';
import { usePlaybackClock } from '../replay/usePlaybackClock';
import { useSessionStore } from '../store/sessionStore';

/** A fetched payload tagged with the request it answers, so a stale response is never shown. */
interface Keyed<T> {
  key: string;
  data?: T;
  error?: string;
}

const NO_BATTLES = new Set<string>();

const STATUS_BANNERS: Record<string, string> = {
  sc: 'Safety car',
  vsc: 'Virtual safety car',
  vsc_ending: 'VSC ending',
  red: 'Red flag',
  yellow: 'Yellow flag',
};

const pageStyle: React.CSSProperties = {
  padding: 'var(--space-6)',
  overflowY: 'auto',
  height: '100%',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
};

const RaceReplayPage: React.FC = () => {
  const { activeSessionKey: storeSessionKey } = useSessionStore();
  const [status, setStatus] = useState<Keyed<ReplayStatus> | null>(null);
  const [loaded, setLoaded] = useState<Keyed<Replay> | null>(null);

  // A deep link is applied once: read on first render, then cleared from the URL, so picking
  // another race in the sidebar afterwards isn't overridden by it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [deepLink] = useState<ReplayStart>(() => readReplayParams(searchParams));
  const [arrived, setArrived] = useState(deepLink.session == null || deepLink.session === storeSessionKey);
  if (!arrived && storeSessionKey === deepLink.session) setArrived(true);

  useEffect(() => {
    if (searchParams.size > 0) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const target = deepLink.session;
    if (!target || target === useSessionStore.getState().activeSessionKey) return;
    // setActiveSession swallows its errors; if the link named an unknown session, fall back
    // to whatever is active rather than waiting forever.
    useSessionStore
      .getState()
      .setActiveSession(target)
      .then(() => {
        if (useSessionStore.getState().activeSessionKey !== target) setArrived(true);
      });
  }, [deepLink]);

  // Until a deep-linked session has loaded, don't fetch (or build) the previously active one.
  const activeSessionKey = arrived ? storeSessionKey : null;

  useEffect(() => {
    if (!activeSessionKey) return;
    const key = activeSessionKey;
    let cancelled = false;
    api
      .getReplayStatus(key)
      .then(st => {
        if (cancelled) return;
        setStatus({ key, data: st });
        if (!st.available) return;
        return api.getReplay(key).then(payload => {
          if (!cancelled) setLoaded({ key, data: decodeReplay(payload) });
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoaded({ key, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionKey]);

  if (!activeSessionKey) {
    return (
      <div className="state-empty">{arrived ? 'Select a race or sprint to replay' : 'Opening replay…'}</div>
    );
  }

  const st = status?.key === activeSessionKey ? status.data : undefined;
  const replay = loaded?.key === activeSessionKey ? loaded : undefined;

  if (replay?.error) {
    return (
      <div className="state-error">
        Couldn't load the replay. {replay.error.replace(/^API Error \d+: /, '')}
      </div>
    );
  }
  if (st && !st.available) {
    return <div className="state-empty">{st.reason}</div>;
  }
  if (!replay?.data) {
    return (
      <div style={pageStyle}>
        <h1 style={{ fontSize: 'var(--fs-2xl)' }}>Race Replay</h1>
        <div style={{ ...cardStyle, padding: 'var(--space-6)' }}>
          <div className="state-loading" style={{ padding: 0, alignItems: 'flex-start', textAlign: 'left' }}>
            <div style={{ fontWeight: 600 }}>{st?.cached ? 'Loading replay…' : 'Building replay…'}</div>
            {st && !st.cached && (
              <div className="text-secondary" style={{ fontSize: 'var(--fs-sm)', maxWidth: 560 }}>
                Loading the whole race's position and car data from FastF1. This takes a few seconds when
                the race is already in the FastF1 cache, and a minute or more on a first download. It only
                happens once per race.
              </div>
            )}
            <div className="skeleton skeleton--bar" style={{ width: '100%' }} />
            <div className="skeleton skeleton--bar" style={{ width: '100%' }} />
          </div>
        </div>
      </div>
    );
  }

  const start = deepLink.session === activeSessionKey ? deepLink : null;
  return <ReplayView key={activeSessionKey} replay={replay.data} sessionKey={activeSessionKey} start={start} />;
};

/** Where a deep link starts playback: just before the leader begins `lap`. */
function startTime(replay: Replay, lap: number | null): number {
  if (lap == null) return replay.tStart;
  if (lap <= 1) return Math.max(replay.tStart, replay.raceStart - 5);
  const prev = leaderLapEnds(replay).find(l => l.lap === lap - 1);
  return prev ? Math.max(replay.tStart, prev.t - 3) : replay.tStart;
}

const ReplayView: React.FC<{ replay: Replay; sessionKey: string; start: ReplayStart | null }> = ({
  replay,
  sessionKey,
  start,
}) => {
  const linked = start != null && (start.lap != null || start.driver != null);
  const [skipRed, setSkipRed] = useState(true);
  const [focus, setFocus] = useState<string | null>(() =>
    start?.driver && replay.byAbbr.has(start.driver) ? start.driver : null
  );
  const [gapMode, setGapMode] = useState<GapMode>('interval');
  const [showBattles, setShowBattles] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [mapRef, mapSize] = useElementSize<HTMLDivElement>();

  const redSkips = useMemo(() => redFlagSkips(replay), [replay]);
  // A linked moment starts playing at 2× so it can be watched; otherwise wait on the grid at 5×.
  const clock = usePlaybackClock({
    tMin: replay.tStart,
    tMax: replay.tEnd,
    initial: startTime(replay, start?.lap ?? null),
    initialSpeed: linked ? 2 : 5,
    autoplay: linked,
    skips: skipRed ? redSkips : undefined,
  });
  const { time, toggle, nudge, seek } = clock;

  const lapTicks = useMemo(() => leaderLapEnds(replay), [replay]);
  const rows = useMemo(() => computeStandings(replay, time), [replay, time]);
  const battles = useMemo(() => (showBattles ? battlesAt(rows) : NO_BATTLES), [rows, showBattles]);
  const trackStatus = trackStatusAt(replay, time);
  const leaderLap = time < replay.raceStart ? 1 : (rows[0]?.lap ?? 1);
  const chequered = replay.finishT != null && time >= replay.finishT;

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
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        nudge(e.shiftKey ? -120 : -30);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        nudge(e.shiftKey ? 120 : 30);
      } else if (e.code === 'Escape') {
        setFocus(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, nudge]);

  const toggleFocus = (abbr: string) => setFocus(f => (f === abbr ? null : abbr));

  let banner: { text: string; colour: string } | null = null;
  if (time < replay.raceStart) banner = { text: 'On the grid', colour: 'var(--text-secondary)' };
  else if (chequered) banner = { text: 'Chequered flag', colour: 'var(--text-primary)' };
  else if (trackStatus && STATUS_BANNERS[trackStatus.kind])
    banner = { text: STATUS_BANNERS[trackStatus.kind], colour: getTrackStatusColour(trackStatus.kind) };

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
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button style={toggleStyle(showLabels)} onClick={() => setShowLabels(v => !v)} title="Driver labels on the map">
            Labels
          </button>
          <button
            style={toggleStyle(showBattles)}
            onClick={() => setShowBattles(v => !v)}
            title="Highlight cars within 1 s of the car ahead"
          >
            Battles
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...cardStyle, flex: '1 1 560px', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div ref={mapRef} style={{ height: 'clamp(340px, 56vh, 640px)', minWidth: 0 }}>
            {mapSize.width > 0 && (
              <ReplayTrack
                replay={replay}
                subscribe={clock.subscribe}
                width={mapSize.width}
                height={mapSize.height}
                focus={focus}
                battles={battles}
                statusKind={trackStatus?.kind}
                showLabels={showLabels}
                onSelect={toggleFocus}
              />
            )}
          </div>
          <PlaybackBar
            replay={replay}
            clock={clock}
            lapTicks={lapTicks}
            leaderLap={leaderLap}
            hasRedFlags={redSkips.length > 0}
            skipRed={skipRed}
            onSkipRedChange={setSkipRed}
            markers={markers}
          />
        </div>

        <div style={{ ...cardStyle, flex: '0 1 340px', minWidth: 290, padding: 'var(--space-3) 0' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 var(--space-3) var(--space-2)',
            }}
          >
            <span className="mono" style={{ fontWeight: 600 }}>
              LAP {leaderLap}/{replay.totalLaps}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button style={toggleStyle(gapMode === 'interval')} onClick={() => setGapMode('interval')}>
                Interval
              </button>
              <button style={toggleStyle(gapMode === 'leader')} onClick={() => setGapMode('leader')}>
                Leader
              </button>
            </div>
          </div>
          <TimingTower rows={rows} mode={gapMode} focus={focus} battles={battles} onSelect={toggleFocus} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...cardStyle, flex: '1.4 1 420px' }}>
          <div style={cardTitleStyle}>Gap to leader</div>
          <GapChart replay={replay} time={time} lapTicks={lapTicks} focus={focus} onSeek={seek} height={260} />
        </div>
        <div style={{ ...cardStyle, flex: '1 1 320px' }}>
          <div style={cardTitleStyle}>Race events</div>
          <EventFeed replay={replay} time={time} lapTicks={lapTicks} onSeek={seek} height={262} />
        </div>
        <div style={{ ...cardStyle, flex: '0.8 1 280px' }}>
          <div style={cardTitleStyle}>Driver</div>
          {focus ? (
            <DriverHud
              sessionKey={sessionKey}
              replay={replay}
              subscribe={clock.subscribe}
              abbr={focus}
              rows={rows}
              onClose={() => setFocus(null)}
            />
          ) : (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>
              Click a car on the map or a row in the timing tower to follow a driver: live speed, gear,
              throttle and brake, and the gaps either side.
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', maxWidth: 900, lineHeight: 1.6 }}>
        Positions are FastF1 GPS samples (about 4 per second) drawn as recorded. Order and gaps between timing
        lines come from each car's distance along the racing line, anchored to the official line crossings, so they
        can differ from the live timing by a place during pit stops. The order shown at the flag is the order on the
        road; post-race penalties are not applied. Under a red flag the order and gaps are held at the moment the
        flag came out.
      </div>
    </div>
  );
};

export default RaceReplayPage;
