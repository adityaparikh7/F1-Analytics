/**
 * Race Replay — the narrated event feed.
 *
 * Combines the race's moments and every on-track pass (from the race-moments API, built from
 * lap data) with the replay's own timelines (race control, pit stops, weather), and turns each
 * into a feed event: a headline, a sentence of context, and the moment it happened.
 *
 * Times come from the replay, not the lap data: a pass is timed to the frame where one car's
 * race distance overtakes the other's; a safety car to when its track status began; a lead
 * change through the pits to when the leader entered the pit lane.
 *
 * Every clause of context is only added when its data checks out (a gap that actually closed,
 * tyres both known, a corner close enough to name). Nothing is invented: if a fact can't be
 * established, the sentence is shorter.
 */

import type { RaceMoment, RaceMoments, RaceOvertake, ReplayWeather } from '../lib/api';
import { getCompoundColour, getFlagColour, getTrackStatusColour, RAIN_COLOUR } from '../lib/colours';
import type { Replay, ReplayDriver } from './decode';
import { pairGapAt } from './relative';
import { computeStandings, distanceAt, leaderLapEnds } from './replayMath';
import type { TrackGeometry } from './trackGeometry';
import { arcAtDistance, projectToArc } from './trackGeometry';
import { weatherAt } from './weather';

export type FeedGroup = 'highlight' | 'overtake' | 'rc' | 'pit' | 'weather';

export interface FeedEvent {
  t: number;
  group: FeedGroup;
  title: string;
  detail?: string;
  colour: string | null;
  lap: number | null;
  /** Driver to follow when the event is clicked, and their rival for shift-click. */
  driver?: string | null;
  other?: string | null;
}

/** A gap must close by at least this much over three laps to be called closing. */
const MIN_CLOSE_S = 0.3;
/** Tyre ages this far apart on the same compound are worth a mention. */
const MIN_TYRE_AGE_GAP = 5;
/** Name a corner if the pass happened within this far before it, or this far after. */
const CORNER_BEFORE_M = 200;
const CORNER_AFTER_M = 60;

const KIND_TO_STATUS: Record<string, string> = { sc: 'sc', vsc: 'vsc', red: 'red' };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function seconds(s: number): string {
  return `${s.toFixed(s < 10 ? 1 : 0)} s`;
}

function compoundName(c: string | null | undefined): string | null {
  return c ? c.toLowerCase() : null;
}

/** The narration toolkit for one replay. */
class Narrator {
  private readonly replay: Replay;
  private readonly geometry: TrackGeometry;
  private readonly leaderEnds: { lap: number; t: number }[];
  private readonly corners: { label: string; s: number }[];

  constructor(replay: Replay, geometry: TrackGeometry) {
    this.replay = replay;
    this.geometry = geometry;
    this.leaderEnds = leaderLapEnds(replay);
    this.corners = replay.corners.map(c => ({ label: `Turn ${c.number}${c.letter}`, s: projectToArc(geometry, c.x, c.y).s }));
  }

  drv(abbr: string | null | undefined): ReplayDriver | undefined {
    return abbr ? this.replay.byAbbr.get(abbr) : undefined;
  }

  lapEnd(drv: ReplayDriver, lap: number): number | null {
    return lap <= 0 ? this.replay.raceStart : (drv.laps.get(lap)?.end_t ?? null);
  }

  /** When the leader began lap `lap` (its end of lap−1). */
  leaderLapStart(lap: number): number {
    if (lap <= 1) return this.replay.raceStart;
    return this.leaderEnds.find(l => l.lap === lap - 1)?.t ?? this.replay.raceStart;
  }

  leaderLapEnd(lap: number): number {
    return this.leaderEnds.find(l => l.lap === lap)?.t ?? this.replay.tEnd;
  }

  /** Leader's lap number in progress at time t. */
  lapAt(t: number): number {
    const done = this.leaderEnds.filter(l => l.t <= t).length;
    return Math.min(done + 1, this.replay.totalLaps);
  }

  /**
   * When `a` got ahead of `b` on lap `lap`: the last frame where a's race distance went from
   * behind b's to ahead, in a window around a's lap. Also whether they swapped back and forth.
   */
  passTime(a: ReplayDriver, b: ReplayDriver, lap: number): { t: number; backAndForth: boolean } | null {
    const from = (this.lapEnd(a, lap - 1) ?? this.leaderLapStart(lap)) - 5;
    const to = (this.lapEnd(a, lap) ?? this.leaderLapEnd(lap)) + 2;
    const step = 1 / this.replay.hz;
    let prev: number | null = null;
    let crossing: number | null = null;
    const flips: number[] = [];
    for (let t = from; t <= to; t += step) {
      const diff = distanceAt(this.replay, a, t) - distanceAt(this.replay, b, t);
      if (prev != null && (prev <= 0) !== (diff <= 0)) {
        flips.push(t);
        if (prev <= 0 && diff > 0) {
          const k = prev / (prev - diff);
          crossing = t - step + k * step;
        }
      }
      prev = diff;
    }
    if (crossing == null) return null;
    const backAndForth = flips.length >= 3 && flips[flips.length - 1] - flips[0] > 5;
    return { t: crossing, backAndForth };
  }

  /** "into Turn 4" / "at Turn 4" when a corner is close to where a car was at time t. */
  corner(drv: ReplayDriver, t: number): string | null {
    if (this.corners.length === 0) return null;
    const s = arcAtDistance(this.geometry, distanceAt(this.replay, drv, t));
    const P = this.geometry.perimeter;
    let best: { label: string; ahead: number } | null = null;
    for (const c of this.corners) {
      const ahead = ((((c.s - s + P / 2) % P) + P) % P) - P / 2;
      if (ahead > CORNER_BEFORE_M || ahead < -CORNER_AFTER_M) continue;
      if (!best || Math.abs(ahead) < Math.abs(best.ahead)) best = { label: c.label, ahead };
    }
    if (!best) return null;
    return best.ahead > 15 ? `into ${best.label}` : `at ${best.label}`;
  }

  /**
   * "closed from 1.9 s to 0.6 s over three laps" — only when the chaser really closed in under
   * green flags (a safety car or red flag bunches the field, which is not a chase).
   */
  gapTrend(chaser: ReplayDriver, ahead: ReplayDriver, lap: number): string | null {
    const from = this.leaderLapStart(lap - 3);
    const to = this.leaderLapEnd(lap);
    const neutralised = this.replay.trackStatus.some(
      iv => (iv.kind === 'sc' || iv.kind === 'vsc' || iv.kind === 'vsc_ending' || iv.kind === 'red') && iv.start_t < to && iv.end_t > from
    );
    if (neutralised) return null;
    const gaps: number[] = [];
    for (let k = lap - 3; k <= lap - 1; k++) {
      const c = this.lapEnd(chaser, k);
      const a = this.lapEnd(ahead, k);
      if (k < 2 || c == null || a == null) return null;
      gaps.push(c - a);
    }
    const [first, , last] = gaps;
    if (first <= 0 || last < 0 || first - last < MIN_CLOSE_S || first > 15) return null;
    return `closed from ${first.toFixed(1)} s to ${last.toFixed(1)} s over three laps`;
  }

  /** "on 12-lap-old mediums against 31-lap-old hards" / "on tyres 19 laps fresher". */
  tyres(a: ReplayDriver, b: ReplayDriver, lap: number): string | null {
    const la = a.laps.get(lap);
    const lb = b.laps.get(lap);
    if (!la?.compound || !lb?.compound || la.tyre_life == null || lb.tyre_life == null) return null;
    if (la.compound !== lb.compound) {
      return `on ${la.tyre_life}-lap-old ${compoundName(la.compound)}s against ${lb.tyre_life}-lap-old ${compoundName(lb.compound)}s`;
    }
    const diff = lb.tyre_life - la.tyre_life;
    if (Math.abs(diff) < MIN_TYRE_AGE_GAP) return null;
    return `on tyres ${plural(Math.abs(diff), 'lap')} ${diff > 0 ? 'fresher' : 'older'}`;
  }

  /** Gap from the leader to the last running car, in seconds. */
  fieldSpread(t: number): number | null {
    const rows = computeStandings(this.replay, t).filter(r => r.state === 'running' || r.state === 'pit');
    if (rows.length < 2) return null;
    const gap = pairGapAt(this.replay, rows[0].driver, rows[rows.length - 1].driver, t);
    return gap != null && gap > 0 ? gap : null;
  }

  positionAt(abbr: string, t: number): number | null {
    return computeStandings(this.replay, t).find(r => r.driver.abbr === abbr)?.position ?? null;
  }
}

function join(...parts: (string | null | undefined)[]): string | undefined {
  const kept = parts.filter(Boolean) as string[];
  if (kept.length === 0) return undefined;
  const s = kept.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// ── Moments ──────────────────────────────────────────────────────────

function passEvent(n: Narrator, title: string, lap: number, a: string, b: string, colour: string | null, group: FeedGroup): FeedEvent | null {
  const A = n.drv(a);
  const B = n.drv(b);
  if (!A || !B) return null;
  const pass = n.passTime(A, B, lap);
  const t = pass?.t ?? n.lapEnd(A, lap) ?? n.leaderLapEnd(lap);
  const detail = join(
    pass ? n.corner(A, pass.t) : `during lap ${lap}`,
    pass?.backAndForth ? 'after a back-and-forth' : null,
    n.tyres(A, B, lap),
    n.gapTrend(A, B, lap)
  );
  return { t, group, title, detail, colour, lap, driver: a, other: b };
}

function momentEvents(n: Narrator, replay: Replay, m: RaceMoment, moments: RaceMoments): FeedEvent[] {
  const lap = m.lap;
  // Moments keep their own lap (a lap-1 move is timed at the driver's line crossing, when the
  // leader may already be on lap 2).
  const highlight = (title: string, t: number, colour: string | null, detail?: string): FeedEvent => ({
    t,
    group: 'highlight',
    title,
    detail,
    colour,
    lap,
    driver: m.driver,
    other: m.other ?? null,
  });

  switch (m.kind) {
    case 'lead_change': {
      const reason = m.reason ?? 'track';
      if ((reason === 'track' || reason === 'duel') && m.driver && m.other) {
        const e = passEvent(n, m.text, lap, m.driver, m.other, getFlagColour('GREEN'), 'highlight');
        return e ? [e] : [];
      }
      const old = n.drv(m.other);
      if (reason === 'pit' && old) {
        const stop = old.stops.find(s => s.lap === lap || s.lap === lap - 1);
        if (stop) {
          const rejoin = stop.out_t != null ? n.positionAt(old.abbr, stop.out_t + 2) : null;
          const detail = join(
            stop.duration != null ? `${old.abbr} spent ${seconds(stop.duration)} in the pit lane` : null,
            rejoin ? `rejoins P${rejoin}` : null
          );
          return [highlight(m.text, stop.in_t, getCompoundColour(old.laps.get(stop.lap + 1)?.compound), detail)];
        }
      }
      if (reason === 'ret' && old?.retiredT != null) return [highlight(m.text, old.retiredT, getFlagColour('RED'))];
      if (reason === 'restart') {
        const red = replay.trackStatus.filter(iv => iv.kind === 'red' && iv.end_t <= n.leaderLapEnd(lap) + 1).pop();
        return [highlight(m.text, red?.end_t ?? n.leaderLapStart(lap), getFlagColour('GREEN'))];
      }
      return [highlight(m.text, n.leaderLapStart(lap), getFlagColour('GREEN'))];
    }

    case 'podium_pass':
      if (m.driver && m.other) {
        const e = passEvent(n, m.text, lap, m.driver, m.other, getFlagColour('GREEN'), 'highlight');
        return e ? [e] : [];
      }
      return [];

    case 'sc':
    case 'vsc':
    case 'red': {
      const kinds = m.kinds ?? [m.kind];
      const windowStart = n.leaderLapStart(lap) - 90;
      const windowEnd = n.leaderLapEnd(m.end_lap ?? lap) + 30;
      const intervals = replay.trackStatus.filter(
        iv => kinds.some(k => KIND_TO_STATUS[k] === iv.kind) && iv.start_t >= windowStart && iv.start_t <= windowEnd
      );
      const start = intervals[0]?.start_t ?? n.leaderLapStart(lap);
      const end = intervals.length ? Math.max(...intervals.map(iv => iv.end_t)) : null;
      const colour = getTrackStatusColour(kinds[kinds.length - 1]);
      const causes = m.drivers ?? [];
      const out: FeedEvent[] = [
        highlight(m.text, start, colour, causes.length ? `Called after ${listOf(causes)} stopped.` : undefined),
      ];
      if (end != null && end < replay.tEnd - 5) {
        const pitted = replay.drivers.filter(d => d.stops.some(s => s.in_t >= start && s.in_t <= end)).length;
        const before = n.fieldSpread(start);
        const after = n.fieldSpread(end + 1);
        const detail = join(
          before != null && after != null && after < before ? `the field bunched up from ${seconds(before)} to ${seconds(after)}` : null,
          pitted ? `${plural(pitted, 'car')} pitted during it` : null
        );
        out.push({
          ...highlight('Green flag — racing resumes', end, getFlagColour('GREEN'), detail),
          lap: n.lapAt(end),
          driver: null,
          other: null,
        });
      }
      return out;
    }

    case 'retirement': {
      const drv = n.drv(m.driver);
      if (!drv?.retiredT) return [];
      const detail = join(m.reason ? `reason given: ${m.reason.toLowerCase()}` : null, `on lap ${lap}`);
      return [highlight(m.text, drv.retiredT, getFlagColour('RED'), detail)];
    }

    case 'start_lead':
    case 'start_gain':
    case 'start_loss': {
      const drv = n.drv(m.driver);
      if (!drv) return [];
      let t = replay.raceStart;
      if (m.kind === 'start_lead') {
        const pole = n.drv(m.other);
        const pass = pole ? n.passTime(drv, pole, 1) : null;
        if (pass) t = pass.t;
      } else {
        t = n.lapEnd(drv, 1) ?? replay.raceStart;
      }
      const detail = m.kind === 'start_lead' && m.pos_before ? `From P${m.pos_before} on the grid.` : undefined;
      return [highlight(m.text, t, m.kind === 'start_loss' ? getFlagColour('RED') : getFlagColour('GREEN'), detail)];
    }

    case 'position_drop': {
      const drv = n.drv(m.driver);
      const t = drv ? (n.lapEnd(drv, lap) ?? n.leaderLapEnd(lap)) : n.leaderLapEnd(lap);
      return [highlight(m.text, t, getFlagColour('RED'))];
    }

    case 'fastest_lap': {
      const drv = n.drv(m.driver);
      if (!drv) return [];
      const lapRow = drv.laps.get(lap);
      const t = lapRow?.end_t ?? n.leaderLapEnd(lap);
      const detail = lapRow?.compound && lapRow.tyre_life != null
        ? `On ${lapRow.tyre_life}-lap-old ${compoundName(lapRow.compound)}s.`
        : undefined;
      return [highlight(m.text, t, 'var(--accent-teal)', detail)];
    }

    case 'finish': {
      const led = moments.leaders.filter(l => l === m.driver).length;
      const detail = join(led ? `led ${led} of ${moments.total_laps} laps` : null);
      return [highlight(m.text, replay.finishT ?? n.leaderLapEnd(lap), getFlagColour('CHEQUERED'), detail)];
    }
  }
  return [];
}

function overtakeEvent(n: Narrator, o: RaceOvertake): FeedEvent | null {
  const title = `${o.driver} passes ${o.other} for P${o.pos_after}`;
  return passEvent(n, title, o.lap, o.driver, o.other, null, 'overtake');
}

// ── Raw timelines (always available, even without lap data) ─────────

function rcColour(category: string | null, flag: string | null): string | null {
  const byFlag = getFlagColour(flag);
  if (byFlag) return byFlag;
  if (category === 'SafetyCar') return getTrackStatusColour('sc');
  return null;
}

function rawEvents(n: Narrator, replay: Replay, narrated: boolean, weather: ReplayWeather | null): FeedEvent[] {
  const events: FeedEvent[] = [
    { t: replay.raceStart, group: 'highlight', title: 'Lights out', colour: getFlagColour('GREEN'), lap: 1 },
  ];
  for (const m of replay.raceControl) {
    if (!m.message) continue;
    events.push({ t: m.t, group: 'rc', title: m.message, colour: rcColour(m.category, m.flag), lap: m.lap ?? n.lapAt(m.t) });
  }
  for (const drv of replay.drivers) {
    for (const stop of drv.stops) {
      if (stop.out_t == null) {
        events.push({ t: stop.in_t, group: 'pit', title: `${drv.abbr} into the pit lane`, colour: null, lap: stop.lap, driver: drv.abbr });
        continue;
      }
      const tyre = drv.laps.get(stop.lap + 1)?.compound ?? null;
      events.push({
        t: stop.out_t,
        group: 'pit',
        title: `${drv.abbr} pit stop · ${stop.duration?.toFixed(1)} s in the pit lane${tyre ? ` → ${compoundName(tyre)}s` : ''}`,
        colour: tyre ? getCompoundColour(tyre) : null,
        lap: stop.lap,
        driver: drv.abbr,
      });
    }
    // Without lap data the retirements and the finish aren't narrated; keep the plain lines.
    if (!narrated && drv.retiredT != null) {
      events.push({ t: drv.retiredT, group: 'pit', title: `${drv.abbr} out of the race`, colour: getFlagColour('RED'), lap: n.lapAt(drv.retiredT), driver: drv.abbr });
    }
  }
  if (!narrated) {
    const winner = replay.drivers.find(d => d.finishT != null && d.finishT === replay.finishT);
    if (winner && replay.finishT != null) {
      events.push({ t: replay.finishT, group: 'highlight', title: `${winner.abbr} takes the chequered flag`, colour: getFlagColour('CHEQUERED'), lap: replay.totalLaps, driver: winner.abbr });
    }
  }
  for (const [start, end] of weather?.rain ?? []) {
    const w = weatherAt(weather, start);
    const detail = w?.track != null ? `Track ${Math.round(w.track)}°${w.air != null ? `, air ${Math.round(w.air)}°` : ''}.` : undefined;
    if (start >= replay.tStart && start <= replay.tEnd) {
      events.push({ t: start, group: 'weather', title: 'Rain begins', detail, colour: RAIN_COLOUR, lap: n.lapAt(start) });
    }
    if (end > start && end <= replay.tEnd) {
      events.push({ t: end, group: 'weather', title: 'Rain stops', colour: RAIN_COLOUR, lap: n.lapAt(end) });
    }
  }
  return events;
}

/** Every feed event for the race, in time order. */
export function buildFeed(
  replay: Replay,
  geometry: TrackGeometry,
  moments: RaceMoments | null,
  weather: ReplayWeather | null
): FeedEvent[] {
  const n = new Narrator(replay, geometry);
  const events = rawEvents(n, replay, moments != null, weather);
  if (moments) {
    for (const m of moments.timeline ?? moments.moments) events.push(...momentEvents(n, replay, m, moments));
    for (const o of moments.overtakes ?? []) {
      if (o.decisive || o.pos_after === 1) continue; // already told as a podium pass or lead change
      const e = overtakeEvent(n, o);
      if (e) events.push(e);
    }
  }
  return events.filter(e => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
}
