/**
 * Race Replay — links into the replay page.
 *
 * `/race-replay?session=2024_01_R&lap=18&driver=VER` opens that race at the start of lap 18,
 * following VER. Every parameter is optional; with none the page shows the active session.
 * Naming the session makes a link work after a reload or from another session.
 */

/** Races and sprints only; 2021's sprints were called "Sprint Qualifying" (`SQ`). */
export function isReplayableSession(year: number, sessionType: string): boolean {
  return sessionType === 'R' || sessionType === 'S' || (sessionType === 'SQ' && year === 2021);
}

export interface ReplayStart {
  session: string | null;
  lap: number | null;
  driver: string | null;
}

export function replayUrl(sessionKey: string, opts: { lap?: number | null; driver?: string | null } = {}): string {
  const params = new URLSearchParams({ session: sessionKey });
  if (opts.lap != null) params.set('lap', String(opts.lap));
  if (opts.driver) params.set('driver', opts.driver);
  return `/race-replay?${params}`;
}

export function readReplayParams(params: URLSearchParams): ReplayStart {
  const lap = Number(params.get('lap'));
  return {
    session: params.get('session'),
    lap: Number.isInteger(lap) && lap > 0 ? lap : null,
    driver: params.get('driver')?.toUpperCase() || null,
  };
}
