/**
 * Race Replay — fetch one driver's telemetry for the replay version the page loaded, so its
 * frames line up with the positions (versions may differ in grid).
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { DriverHud as Hud } from './decode';
import { decodeHud } from './decode';

interface Loaded {
  key: string;
  hud?: Hud;
  error?: string;
}

/** Telemetry for `abbr` on the grid of the replay version the page loaded. */
export function useDriverHud(sessionKey: string, abbr: string, version: number): { hud?: Hud; error?: string } {
  const key = `${sessionKey}:${abbr}:${version}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getReplayHud(sessionKey, abbr, version)
      .then(payload => {
        if (!cancelled) setLoaded({ key, hud: decodeHud(payload) });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoaded({ key, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, abbr, version, key]);

  return loaded?.key === key ? { hud: loaded.hud, error: loaded.error } : {};
}
