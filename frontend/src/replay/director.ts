/**
 * Race Replay — the TV director: who should the camera follow right now?
 *
 * `candidateShots` scores everything worth showing at time t from the replay alone:
 *  - battles: adjacent cars on the same lap within 1.5 s, weighted by how close, where they are
 *    in the race and whether the gap is closing (more after a restart or on the final lap);
 *  - a top-ten car in the pits; a car that just retired or is crawling on track (urgent);
 *  - the leader at the start, at restarts and as the fallback; the winner at the flag.
 *
 * `createDirector` turns those scores into camera choices with hysteresis: a new shot must
 * clearly beat the current one (×1.25 + 0.25) and stay best for a moment before the cut, and a
 * shot is held for a minimum time measured both on screen (so 50× playback doesn't cut every
 * second) and in race time (so 1× doesn't linger). Urgent shots cut in faster. Seeking resets.
 */

import type { Replay } from './decode';
import type { StandingRow } from './replayMath';
import { computeStandings, distanceAt, trackStatusAt } from './replayMath';

export interface Shot {
  /** Stable identity: a battle keeps its key when the two cars swap places. */
  key: string;
  focus: string;
  caption: string;
  score: number;
  urgent: boolean;
}

const BATTLE_GAP_S = 1.5;
const MAX_CHASE_GAP_S = 10;
const MAX_CLOSING_S_PER_LAP = 2;
/** A crawling car: below this share of the field's median pace, for two 3 s windows running. */
const SLOW_SHARE = 0.25;
/** Cars this close to a pit stop are at pit-lane speed, not in trouble. */
const PIT_MARGIN_BEFORE_S = 30;
const PIT_MARGIN_AFTER_S = 15;
const START_WINDOW = [-5, 45];
const RESTART_WINDOW_S = 25;
const WINNER_HOLD_S = 10;

/** P1 = 3.0 falling to P10 = 1.0, then tailing off. */
export function positionWeight(p: number): number {
  return p <= 10 ? 1 + (2 * (10 - p)) / 9 : 0.6 * Math.exp(-(p - 10) / 5);
}

/** How fast `behind` has been catching `ahead` per lap over its last three laps (s/lap, + = closing). */
function closingRate(behind: StandingRow, ahead: StandingRow): number {
  const done = behind.lap - 1;
  const gaps: number[] = [];
  for (let k = done - 2; k <= done; k++) {
    const b = behind.driver.laps.get(k)?.end_t;
    const a = ahead.driver.laps.get(k)?.end_t;
    if (k < 1 || b == null || a == null) return 0;
    gaps.push(b - a);
  }
  // Lap times that span a stoppage or a pit stop say nothing about a chase.
  if (gaps.some(g => Math.abs(g) > MAX_CHASE_GAP_S)) return 0;
  const rate = (gaps[0] - gaps[2]) / 2;
  return Math.abs(rate) > MAX_CLOSING_S_PER_LAP ? 0 : rate;
}

function sinceNeutralisedEnded(replay: Replay, t: number): number | null {
  let latest: number | null = null;
  for (const iv of replay.trackStatus) {
    if ((iv.kind === 'sc' || iv.kind === 'vsc' || iv.kind === 'red') && iv.end_t <= t) {
      latest = latest == null ? iv.end_t : Math.max(latest, iv.end_t);
    }
  }
  return latest == null ? null : t - latest;
}

export function candidateShots(replay: Replay, t: number, rows: StandingRow[] = computeStandings(replay, t)): Shot[] {
  const shots: Shot[] = [];
  const leader = rows[0];
  if (!leader) return shots;
  const sinceStart = t - replay.raceStart;
  const status = trackStatusAt(replay, t)?.kind;
  const neutralised = status === 'sc' || status === 'vsc' || status === 'vsc_ending' || status === 'red';
  const sinceRestart = sinceNeutralisedEnded(replay, t);
  const inStart = sinceStart >= START_WINDOW[0] && sinceStart <= START_WINDOW[1];
  const inRestart = !neutralised && sinceRestart != null && sinceRestart <= RESTART_WINDOW_S;
  const finalLap = leader.lap >= replay.totalLaps && leader.state !== 'finished';

  // The winner, just after the flag.
  if (replay.finishT != null && t >= replay.finishT && t <= replay.finishT + WINNER_HOLD_S) {
    shots.push({ key: 'winner', focus: leader.driver.abbr, caption: `${leader.driver.abbr} takes the chequered flag`, score: 8, urgent: true });
  }

  // Leader: the start, restarts, and the fallback.
  // Keyed by driver, so a change of leader is a cut (subject to the hold times), not a flicker.
  const leaderKey = `leader:${leader.driver.abbr}`;
  if (inStart) shots.push({ key: leaderKey, focus: leader.driver.abbr, caption: `Start — ${leader.driver.abbr} leads`, score: 3, urgent: false });
  else if (inRestart) shots.push({ key: leaderKey, focus: leader.driver.abbr, caption: `Restart — ${leader.driver.abbr} leads`, score: 2.5, urgent: false });
  else shots.push({ key: leaderKey, focus: leader.driver.abbr, caption: `${leader.driver.abbr} leads`, score: 1, urgent: false });

  if (sinceStart < 0) return shots;

  // Battles.
  const battleBoost = finalLap ? 1.8 : inRestart ? 1.5 : inStart ? 1.2 : 1;
  for (let i = 1; i < rows.length; i++) {
    const ahead = rows[i - 1];
    const behind = rows[i];
    if (neutralised || ahead.state !== 'running' || behind.state !== 'running') continue;
    if (behind.interval?.kind !== 'time' || behind.interval.seconds >= BATTLE_GAP_S) continue;
    const gap = behind.interval.seconds;
    const closing = closingRate(behind, ahead);
    let score = 4 * Math.pow((BATTLE_GAP_S - gap) / BATTLE_GAP_S, 1.5) * positionWeight(behind.position);
    score *= 1 + 0.5 * Math.min(Math.max(closing / 0.5, 0), 1);
    const before = distanceAt(replay, ahead.driver, t - 10) - distanceAt(replay, behind.driver, t - 10);
    if (sinceStart > 10 && before < 0) score *= 1.3; // they swapped places in the last ten seconds
    score *= battleBoost;
    const pair = [ahead.driver.abbr, behind.driver.abbr].sort().join('-');
    const caption = `${finalLap ? 'Final lap — b' : 'B'}attle for P${ahead.position} — ${behind.driver.abbr} ${gap.toFixed(1)} s behind ${ahead.driver.abbr}${closing > 0.05 ? `, closing ${closing.toFixed(1)} s/lap` : ''}`;
    shots.push({ key: `battle:${pair}`, focus: behind.driver.abbr, caption, score, urgent: false });
  }

  // Pit stops of top-ten cars (in the pit lane, or out within the last four seconds).
  for (const row of rows) {
    if (row.position > 10) continue;
    const recent = row.driver.stops.find(s => s.in_t <= t && t < (s.out_t ?? Infinity) + 4);
    if (!recent || neutralised) continue;
    shots.push({
      key: `pit:${row.driver.abbr}:${recent.in_t}`,
      focus: row.driver.abbr,
      caption: `${row.driver.abbr} (P${row.position}) in the pits`,
      score: 2 * positionWeight(row.position),
      urgent: row.position <= 3,
    });
  }

  // Incidents: a fresh retirement, or a car crawling on track under green.
  const running = rows.filter(r => r.state === 'running');
  const pace = (drv: StandingRow['driver'], from: number) =>
    (distanceAt(replay, drv, from + 3) - distanceAt(replay, drv, from)) / 3;
  const rates = running.map(r => pace(r.driver, t - 3));
  const median = [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)] ?? 0;
  for (const drv of replay.drivers) {
    if (drv.retiredT != null && t >= drv.retiredT - 1 && t <= drv.retiredT + 20) {
      const row = rows.find(r => r.driver.abbr === drv.abbr);
      shots.push({
        key: `out:${drv.abbr}`,
        focus: drv.abbr,
        caption: `${drv.abbr} is out of the race`,
        score: 7 * Math.max(positionWeight(row?.position ?? 20), 0.5),
        urgent: true,
      });
    }
  }
  if (!neutralised && sinceStart > 30 && median > 20) {
    running.forEach((r, i) => {
      if (rates[i] >= SLOW_SHARE * median || pace(r.driver, t - 6) >= SLOW_SHARE * median) return;
      const nearPit = r.driver.stops.some(
        s => t >= s.in_t - PIT_MARGIN_BEFORE_S && t <= (s.out_t ?? Infinity) + PIT_MARGIN_AFTER_S
      );
      if (nearPit) return;
      shots.push({ key: `slow:${r.driver.abbr}`, focus: r.driver.abbr, caption: `${r.driver.abbr} slowing on track`, score: 5, urgent: true });
    });
  }
  return shots;
}

// ── Cutting between shots ─────────────────────────────────────────────

export interface DirectorPick {
  focus: string;
  caption: string;
}

/** Evaluate this often (wall clock). */
const EVAL_MS = 250;
/** Hold a shot at least this long on screen and in race time (urgent cuts: on screen only). */
const MIN_HOLD_SCREEN_MS = 5000;
const MIN_HOLD_RACE_S = 10;
const URGENT_HOLD_SCREEN_MS = 1500;
/** A challenger must stay best this long before the cut. */
const CHALLENGE_SCREEN_MS = 1000;
const CHALLENGE_RACE_S = 2;
/**
 * A seek (pick afresh): time going backwards, or forwards faster than the fastest playback
 * speed could have carried it since the last frame.
 */
const MAX_SPEED = 100;
const SEEK_SLACK_S = 2;

export interface Director {
  tick: (t: number) => void;
  reset: () => void;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => DirectorPick | null;
}

export function createDirector(replay: Replay): Director {
  const listeners = new Set<() => void>();
  let pick: DirectorPick | null = null;
  // The followed car is fixed when a shot is cut to: a battle stays on the same car when the
  // pair swap places, only its caption follows the action.
  let current: { key: string; focus: string; sinceWall: number; sinceRace: number } | null = null;
  let challenger: { key: string; sinceWall: number; sinceRace: number } | null = null;
  let lastEval = -Infinity;
  let lastT: number | null = null;
  let lastWall = 0;

  const publish = (next: DirectorPick | null) => {
    if (next?.focus === pick?.focus && next?.caption === pick?.caption) return;
    pick = next;
    listeners.forEach(cb => cb());
  };

  const reset = () => {
    current = null;
    challenger = null;
    lastEval = -Infinity;
    lastT = null;
  };

  const tick = (t: number) => {
    const now = performance.now();
    const seeked =
      lastT != null && (t < lastT - 0.5 || t - lastT > ((now - lastWall) / 1000) * MAX_SPEED + SEEK_SLACK_S);
    lastT = t;
    lastWall = now;
    if (seeked) {
      current = null;
      challenger = null;
    } else if (now - lastEval < EVAL_MS) {
      return;
    }
    lastEval = now;

    const shots = candidateShots(replay, t);
    if (shots.length === 0) return;
    const best = shots.reduce((a, b) => (b.score > a.score ? b : a));
    const held = current ? shots.find(s => s.key === current!.key) : undefined;

    if (!current) {
      current = { key: best.key, focus: best.focus, sinceWall: now, sinceRace: t };
      challenger = null;
      publish({ focus: best.focus, caption: best.caption });
      return;
    }

    if (best.key !== current.key && best.score > 1.25 * (held?.score ?? 0) + 0.25) {
      if (challenger?.key !== best.key) challenger = { key: best.key, sinceWall: now, sinceRace: t };
      const challengeMet = now - challenger.sinceWall >= CHALLENGE_SCREEN_MS && t - challenger.sinceRace >= CHALLENGE_RACE_S;
      const holdMet = best.urgent
        ? now - current.sinceWall >= URGENT_HOLD_SCREEN_MS
        : now - current.sinceWall >= MIN_HOLD_SCREEN_MS && t - current.sinceRace >= MIN_HOLD_RACE_S;
      if ((challengeMet || (best.urgent && !held)) && holdMet) {
        current = { key: best.key, focus: best.focus, sinceWall: now, sinceRace: t };
        challenger = null;
        publish({ focus: best.focus, caption: best.caption });
        return;
      }
    } else {
      challenger = null;
    }
    // Keep the current shot, with its caption refreshed (gaps change).
    if (held) publish({ focus: current.focus, caption: held.caption });
  };

  return {
    tick,
    reset,
    subscribe: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => pick,
  };
}
