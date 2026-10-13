/**
 * Race Replay — event feed.
 *
 * Race control messages, pit stops and retirements, revealed as the replay reaches them
 * (newest first). Clicking an event jumps to just before it.
 */

import React, { useMemo, useState } from 'react';
import { getCompoundColour, getFlagColour, getTrackStatusColour } from '../lib/colours';
import { formatCompound } from '../lib/format';
import type { Replay } from './decode';
import { formatRaceClock } from './replayMath';
import { selectStyle } from './styles';

type EventKind = 'rc' | 'pit' | 'out' | 'race';
type Filter = 'all' | 'rc' | 'cars';

interface FeedEvent {
  t: number;
  kind: EventKind;
  text: string;
  colour: string | null;
  lap: number | null;
}

interface Props {
  replay: Replay;
  time: number;
  lapTicks: { lap: number; t: number }[];
  onSeek: (t: number) => void;
  height?: number;
}

const MAX_SHOWN = 200;

function rcColour(category: string | null, flag: string | null): string | null {
  const byFlag = getFlagColour(flag);
  if (byFlag) return byFlag;
  if (category === 'SafetyCar') return getTrackStatusColour('sc');
  return null;
}

function buildEvents(replay: Replay, lapAt: (t: number) => number): FeedEvent[] {
  const events: FeedEvent[] = [];
  events.push({ t: replay.raceStart, kind: 'race', text: 'Lights out', colour: getFlagColour('GREEN'), lap: 1 });

  for (const m of replay.raceControl) {
    if (!m.message) continue;
    events.push({ t: m.t, kind: 'rc', text: m.message, colour: rcColour(m.category, m.flag), lap: m.lap ?? lapAt(m.t) });
  }

  for (const drv of replay.drivers) {
    for (const stop of drv.stops) {
      if (stop.out_t == null) {
        events.push({ t: stop.in_t, kind: 'pit', text: `${drv.abbr} into the pit lane`, colour: null, lap: stop.lap });
        continue;
      }
      const tyre = drv.laps.get(stop.lap + 1)?.compound ?? null;
      events.push({
        t: stop.out_t,
        kind: 'pit',
        text: `${drv.abbr} pit stop · ${stop.duration?.toFixed(1)}s in the pit lane${tyre ? ` → ${formatCompound(tyre)}` : ''}`,
        colour: tyre ? getCompoundColour(tyre) : null,
        lap: stop.lap,
      });
    }
    if (drv.retiredT != null) {
      events.push({
        t: drv.retiredT,
        kind: 'out',
        text: `${drv.abbr} out of the race`,
        colour: getFlagColour('RED'),
        lap: lapAt(drv.retiredT),
      });
    }
  }

  const winner = replay.drivers.find(d => d.finishT != null && d.finishT === replay.finishT);
  if (winner && replay.finishT != null) {
    events.push({
      t: replay.finishT,
      kind: 'race',
      text: `${winner.abbr} takes the chequered flag`,
      colour: getFlagColour('CHEQUERED'),
      lap: replay.totalLaps,
    });
  }
  return events.sort((a, b) => a.t - b.t);
}

export const EventFeed: React.FC<Props> = ({ replay, time, lapTicks, onSeek, height = 300 }) => {
  const [filter, setFilter] = useState<Filter>('all');

  const events = useMemo(() => {
    const lapAt = (t: number) => {
      const done = lapTicks.filter(l => l.t <= t).length;
      return Math.min(done + 1, replay.totalLaps);
    };
    return buildEvents(replay, lapAt);
  }, [replay, lapTicks]);

  const visible = useMemo(() => {
    const shown = events.filter(
      e => e.t <= time && (filter === 'all' || (filter === 'rc' ? e.kind === 'rc' : e.kind !== 'rc'))
    );
    return shown.slice(-MAX_SHOWN).reverse();
  }, [events, time, filter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
      <select style={{ ...selectStyle, alignSelf: 'flex-start' }} value={filter} onChange={e => setFilter(e.target.value as Filter)}>
        <option value="all">All events</option>
        <option value="rc">Race control</option>
        <option value="cars">Pit stops &amp; retirements</option>
      </select>
      <div style={{ height, overflowY: 'auto', minHeight: 0 }}>
        {visible.length === 0 && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)', padding: 'var(--space-2) 0' }}>
            Nothing yet — events appear as the replay reaches them.
          </div>
        )}
        {visible.map((e, i) => (
          <div
            key={`${e.t}-${e.kind}-${i}`}
            onClick={() => onSeek(e.t - 3)}
            title="Jump to this moment"
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              padding: '5px 0',
              borderBottom: '1px solid var(--border-default)',
              cursor: 'pointer',
              fontSize: 'var(--fs-sm)',
            }}
          >
            <span
              style={{
                width: 3,
                alignSelf: 'stretch',
                borderRadius: 1,
                background: e.colour ?? 'var(--border-strong)',
                flexShrink: 0,
              }}
            />
            <span className="mono" style={{ width: 52, flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 'var(--fs-xs)' }}>
              {formatRaceClock(replay, e.t)}
              {e.lap != null && <div>L{e.lap}</div>}
            </span>
            <span style={{ color: e.kind === 'rc' ? 'var(--text-secondary)' : 'var(--text-primary)', minWidth: 0 }}>
              {e.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
