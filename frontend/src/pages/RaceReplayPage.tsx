/**
 * Race Replay — in-depth page.
 *
 * Rewatch a race or sprint from FastF1's GPS position data: every car on a 2D map, a follow cam
 * or a 3D track, a live timing tower and relative timing, the race's events narrated in sync,
 * telemetry for a followed driver and head-to-head comparison. This file loads the replay and
 * handles deep links; the replay itself is `replay/ReplayView.tsx`.
 *
 * Reached from the Topbar's Replay button, or from a moment in the Race Moments panel, which
 * links here as `?session=…&lap=…&driver=…` (see `replay/links.ts`) to start at that lap
 * following that driver. The first visit to a race builds its replay on the backend (seconds
 * from a warm FastF1 cache).
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ReplayStatus } from '../lib/api';
import { ReplayView } from '../replay/ReplayView';
import type { Replay } from '../replay/decode';
import { decodeReplay } from '../replay/decode';
import type { ReplayStart } from '../replay/links';
import { readReplayParams } from '../replay/links';
import { cardStyle, replayPageStyle as pageStyle } from '../replay/styles';
import { useSessionStore } from '../store/sessionStore';

/** A fetched payload tagged with the request it answers, so a stale response is never shown. */
interface Keyed<T> {
  key: string;
  data?: T;
  error?: string;
}

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

export default RaceReplayPage;
