/**
 * Race Replay — weather lookups on the replay clock.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ReplayWeather, ReplayWeatherSample } from '../lib/api';

/** The latest sample at or before `t` (the first one before the data starts). */
export function weatherAt(weather: ReplayWeather | null | undefined, t: number): ReplayWeatherSample | null {
  const s = weather?.samples;
  if (!s || s.length === 0) return null;
  let lo = 0;
  let hi = s.length - 1;
  if (t < s[0].t) return s[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return s[lo];
}

export function isRaining(weather: ReplayWeather | null | undefined, t: number): boolean {
  return weather?.rain.some(([a, b]) => t >= a && t < b) ?? false;
}

interface Loaded {
  key: string;
  weather: ReplayWeather | null;
}

/** Weather for a session; null while loading or when the session has none. Failures are quiet. */
export function useReplayWeather(sessionKey: string): ReplayWeather | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getReplayWeather(sessionKey)
      .then(w => {
        if (!cancelled) setLoaded({ key: sessionKey, weather: w.source ? w : null });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: sessionKey, weather: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);
  return loaded?.key === sessionKey ? loaded.weather : null;
}
