/**
 * Telemetry — lap list helpers shared by the picker and the page.
 */

import type { LapData } from '../lib/api';

/** Laps compared at once: one reference and up to three others. */
export const MAX_LAPS = 4;

/** Playback speeds for a single lap, slow motion included. */
export const LAP_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

export interface DriverSummary {
  driver: string;
  team: string | null;
  best: LapData;
}

/** Laps more than this much slower than the driver's best are out-laps, in-laps or traffic. */
export const SLOW_FACTOR = 1.07;

export function lapFlags(lap: LapData): string[] {
  const flags: string[] = [];
  const ts = lap.track_status ?? '';
  if (lap.is_pit_out_lap) flags.push('OUT');
  if (lap.is_pit_in_lap) flags.push('IN');
  if (ts.includes('5')) flags.push('RED');
  else if (ts.includes('4')) flags.push('SC');
  else if (ts.includes('6')) flags.push('VSC');
  else if (ts.includes('2')) flags.push('YEL');
  if (lap.lap_number === 1) flags.push('L1');
  return flags;
}

export function bestLaps(laps: LapData[]): DriverSummary[] {
  const best = new Map<string, LapData>();
  for (const lap of laps) {
    if (lap.lap_time == null) continue;
    const prev = best.get(lap.driver);
    if (!prev || lap.lap_time < (prev.lap_time as number)) best.set(lap.driver, lap);
  }
  return [...best.values()]
    .sort((a, b) => (a.lap_time as number) - (b.lap_time as number))
    .map(b => ({ driver: b.driver, team: b.team, best: b }));
}

