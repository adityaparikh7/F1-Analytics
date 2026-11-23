/**
 * Telemetry — fetch lap traces for the selected laps, keeping the ones already loaded so adding
 * or removing a lap only fetches what's new.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { LapTrace } from '../lib/api';

export interface LapSpec {
  driver: string;
  lap: number;
}

/** Unique id and on-map label of a lap, e.g. "VER L16". */
export function lapKey(spec: LapSpec): string {
  return `${spec.driver} L${spec.lap}`;
}

export interface LapTraceStore {
  session: string;
  traces: Map<string, LapTrace>;
  errors: Map<string, string>;
}

function empty(session: string): LapTraceStore {
  return { session, traces: new Map(), errors: new Map() };
}

/** Loaded traces by `lapKey`, plus errors; a selected key in neither is still loading. */
export function useLapTraces(sessionKey: string, specs: LapSpec[]): LapTraceStore {
  const [store, setStore] = useState<LapTraceStore>(() => empty(sessionKey));
  const inflight = useRef(new Set<string>());
  const current = store.session === sessionKey ? store : empty(sessionKey);
  const wanted = specs.map(s => `${s.driver}:${s.lap}`).join('|');

  useEffect(() => {
    for (const item of wanted ? wanted.split('|') : []) {
      const [driver, lapText] = item.split(':');
      const spec = { driver, lap: Number(lapText) };
      const key = lapKey(spec);
      const flightKey = `${sessionKey}|${key}`;
      if (current.traces.has(key) || current.errors.has(key) || inflight.current.has(flightKey)) continue;
      inflight.current.add(flightKey);
      api
        .getLapTrace(sessionKey, spec.driver, spec.lap)
        .then(trace =>
          setStore(prev => {
            const base = prev.session === sessionKey ? prev : empty(sessionKey);
            return { ...base, traces: new Map(base.traces).set(key, trace) };
          })
        )
        .catch((err: Error) =>
          setStore(prev => {
            const base = prev.session === sessionKey ? prev : empty(sessionKey);
            return { ...base, errors: new Map(base.errors).set(key, err.message.replace(/^API Error \d+: /, '')) };
          })
        )
        .finally(() => inflight.current.delete(flightKey));
    }
  }, [sessionKey, wanted, current]);

  return current;
}
