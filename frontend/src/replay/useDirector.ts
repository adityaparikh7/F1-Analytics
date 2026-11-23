/**
 * Race Replay — run the TV director (see `director.ts`) against the playback clock.
 * Returns its current pick while enabled, null otherwise.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Replay } from './decode';
import type { DirectorPick } from './director';
import { createDirector } from './director';

export function useDirector(
  replay: Replay,
  subscribe: (cb: (t: number) => void) => () => void,
  enabled: boolean
): DirectorPick | null {
  const director = useMemo(() => createDirector(replay), [replay]);

  useEffect(() => {
    if (!enabled) return;
    director.reset();
    return subscribe(t => director.tick(t));
  }, [director, subscribe, enabled]);

  const pick = useSyncExternalStore(director.subscribe, director.getSnapshot);
  return enabled ? pick : null;
}
