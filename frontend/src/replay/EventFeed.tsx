/**
 * Race Replay — narrated event feed.
 *
 * The race told as it happens (see `narrate.ts`): highlights with a sentence of context,
 * every overtake, race control messages, pit stops and the weather, revealed as the replay
 * reaches them, newest first. Clicking an event jumps to just before it and follows the
 * driver involved; shift-click also compares them with the other driver in it.
 */

import React, { useMemo, useState } from 'react';
import type { RaceMoments, ReplayWeather } from '../lib/api';
import type { Replay } from './decode';
import type { FeedEvent, FeedGroup } from './narrate';
import { buildFeed } from './narrate';
import { formatRaceClock } from './replayMath';
import { selectStyle } from './styles';
import type { TrackGeometry } from './trackGeometry';

type Filter = 'highlights' | 'all' | 'overtakes' | 'rc' | 'pits';

const FILTERS: { id: Filter; label: string; groups: FeedGroup[] | null }[] = [
  { id: 'highlights', label: 'Highlights', groups: ['highlight', 'weather'] },
  { id: 'all', label: 'All events', groups: null },
  { id: 'overtakes', label: 'Overtakes', groups: ['overtake'] },
  { id: 'rc', label: 'Race control', groups: ['rc'] },
  { id: 'pits', label: 'Pit stops & retirements', groups: ['pit'] },
];

interface Props {
  replay: Replay;
  geometry: TrackGeometry;
  /** Lap-data moments; without them the feed falls back to the raw timelines. */
  moments: RaceMoments | null;
  weather: ReplayWeather | null;
  time: number;
  /** Jump to t and follow `driver` (and compare with `rival`, on shift-click). */
  onSeek: (t: number, driver?: string | null, rival?: string | null) => void;
  height?: number;
}

const MAX_SHOWN = 200;

export const EventFeed: React.FC<Props> = ({ replay, geometry, moments, weather, time, onSeek, height = 300 }) => {
  const [filter, setFilter] = useState<Filter>('highlights');

  const events = useMemo(() => buildFeed(replay, geometry, moments, weather), [replay, geometry, moments, weather]);

  const visible = useMemo(() => {
    const groups = FILTERS.find(f => f.id === filter)?.groups;
    const shown = events.filter(e => e.t <= time && (!groups || groups.includes(e.group)));
    return shown.slice(-MAX_SHOWN).reverse();
  }, [events, time, filter]);

  const open = (e: FeedEvent, shift: boolean) => onSeek(e.t - 3, e.driver ?? null, shift ? (e.other ?? null) : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
      <select
        style={{ ...selectStyle, alignSelf: 'flex-start' }}
        value={filter}
        onChange={e => setFilter(e.target.value as Filter)}
      >
        {FILTERS.map(f => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <div style={{ height, overflowY: 'auto', minHeight: 0 }}>
        {visible.length === 0 && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)', padding: 'var(--space-2) 0' }}>
            Nothing yet — events appear as the replay reaches them.
          </div>
        )}
        {visible.map((e, i) => (
          <div
            key={`${e.t}-${e.group}-${i}`}
            onClick={ev => open(e, ev.shiftKey)}
            title={e.driver ? `Watch this · follows ${e.driver}${e.other ? ` (shift: compare with ${e.other})` : ''}` : 'Watch this'}
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              padding: '6px 0',
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
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  color: e.group === 'rc' ? 'var(--text-secondary)' : 'var(--text-primary)',
                  fontWeight: e.group === 'highlight' ? 600 : 400,
                }}
              >
                {e.title}
              </span>
              {e.detail && (
                <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)', marginTop: 2 }}>{e.detail}</div>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
