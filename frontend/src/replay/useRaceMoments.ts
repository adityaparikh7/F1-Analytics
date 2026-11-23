/**
 * Race Replay — the race's moments and overtakes from lap data, for the narrated feed.
 * Null while loading, or when the race's laps aren't ingested (the feed then shows raw events).
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { RaceMoments } from '../lib/api';

interface Loaded {
  key: string;
  moments: RaceMoments | null;
}

export function useRaceMoments(sessionKey: string): RaceMoments | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getRaceMoments(sessionKey)
      .then(m => {
        if (!cancelled) setLoaded({ key: sessionKey, moments: m });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: sessionKey, moments: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);
  return loaded?.key === sessionKey ? loaded.moments : null;
}
