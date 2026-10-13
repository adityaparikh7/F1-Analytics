/**
 * Race Moments Panel — low-level view.
 *
 * The race at a glance: who won and by how much, a strip showing who led every lap (with the
 * safety car, VSC and red flag periods above it), headline stats, and the race told in about
 * ten moments — the start, lead changes, incidents and their cause, retirements, decisive
 * podium passes, the fastest lap.
 *
 * It is also the way into the replay: every moment and every lap of the strip opens
 * /race-replay at that lap, following the driver involved. Computed from ingested lap data, so
 * it loads instantly and never waits on a replay build (the replay page builds on first open).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  CircleX,
  Flag,
  OctagonAlert,
  Play,
  Siren,
  Timer,
  TrendingDown,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import { api } from '../../lib/api';
import type { RaceMoment, RaceMomentKind, RaceMoments } from '../../lib/api';
import { ensureReadable, getDriverColour, getTrackStatusColour } from '../../lib/colours';
import { isReplayableSession, replayUrl } from '../../replay/links';

interface Loaded {
  key: string;
  data?: RaceMoments;
  error?: string;
}

const ICONS: Record<RaceMomentKind, LucideIcon> = {
  finish: Trophy,
  start_lead: Flag,
  start_gain: TrendingUp,
  start_loss: TrendingDown,
  lead_change: ArrowLeftRight,
  sc: Siren,
  vsc: Siren,
  red: OctagonAlert,
  retirement: CircleX,
  podium_pass: ArrowLeftRight,
  position_drop: TrendingDown,
  fastest_lap: Timer,
};

const STRIP_HEIGHT = 30;

function parseKey(key: string): { year: number; type: string } {
  const [year, , type] = key.split('_');
  return { year: Number(year), type: type ?? '' };
}

const RaceMomentsPanel: React.FC<PanelProps> = ({ sessionKey, width }) => {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const replayable = sessionKey != null && isReplayableSession(parseKey(sessionKey).year, parseKey(sessionKey).type);

  useEffect(() => {
    if (!sessionKey || !replayable) return;
    let cancelled = false;
    api
      .getRaceMoments(sessionKey)
      .then(data => {
        if (!cancelled) setLoaded({ key: sessionKey, data });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoaded({ key: sessionKey, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, replayable]);

  if (!sessionKey) return <div className="state-empty">Select a race to see its key moments</div>;
  if (!replayable) return <div className="state-empty">Race moments are available for races and sprints</div>;
  if (!loaded || loaded.key !== sessionKey) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }
  if (loaded.error || !loaded.data) {
    return loaded.error?.startsWith('API Error 404') ? (
      <div className="state-empty">No lap data ingested for this race yet</div>
    ) : (
      <div className="state-error">{loaded.error}</div>
    );
  }

  const open = (opts: { lap?: number; driver?: string | null } = {}) => navigate(replayUrl(sessionKey, opts));
  return <MomentsView data={loaded.data} width={width} open={open} />;
};

const MomentsView: React.FC<{
  data: RaceMoments;
  width: number;
  open: (opts?: { lap?: number; driver?: string | null }) => void;
}> = ({ data, width, open }) => {
  const colourOf = (driver: string | null | undefined) =>
    driver ? ensureReadable(getDriverColour(driver, data.teams[driver])) : 'var(--text-tertiary)';
  const { stats } = data;

  const statLine = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${stats.lead_changes} lead change${stats.lead_changes === 1 ? '' : 's'}`);
    const led = stats.laps_led.slice(0, 2).map(l => `${l.driver} ${l.laps}`);
    if (led.length) parts.push(`led ${led.join(', ')}`);
    parts.push(`${stats.passes} passes`);
    parts.push(`${stats.dnfs} DNF`);
    if (stats.biggest_mover) parts.push(`biggest mover ${stats.biggest_mover.driver} +${stats.biggest_mover.gain}`);
    return parts.join(' · ');
  }, [stats]);

  const winner = data.moments.find(m => m.kind === 'finish');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Trophy size={14} color={colourOf(data.winner?.driver)} style={{ flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            fontSize: 'var(--fs-sm)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {winner?.text ?? 'Race moments'}
        </span>
        <button
          className="btn btn--outline"
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => open()}
          title="Open the race replay"
        >
          <Play size={11} /> Replay
        </button>
      </div>

      <LeaderStrip data={data} width={Math.max(width - 4, 120)} colourOf={colourOf} onLap={lap => open({ lap })} />

      <div className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
        {statLine}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {data.moments.map((m, i) => (
          <MomentRow key={`${m.lap}-${m.kind}-${i}`} moment={m} colour={colourOf(m.driver)} onOpen={() => open(m)} />
        ))}
      </div>

      {data.caveats.length > 0 && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>{data.caveats.join(' ')}</div>
      )}
    </div>
  );
};

function iconColour(m: RaceMoment, driverColour: string): string {
  switch (m.kind) {
    case 'sc':
    case 'vsc':
    case 'red':
      return getTrackStatusColour(m.kind);
    case 'retirement':
    case 'start_loss':
    case 'position_drop':
      return 'var(--accent-red)';
    case 'start_gain':
    case 'fastest_lap':
      return 'var(--accent-teal)';
    case 'finish':
      return 'var(--text-primary)';
    default:
      return driverColour;
  }
}

const MomentRow: React.FC<{ moment: RaceMoment; colour: string; onOpen: () => void }> = ({
  moment,
  colour,
  onOpen,
}) => {
  const Icon = ICONS[moment.kind] ?? Flag;
  return (
    <div
      className="race-moment"
      onClick={onOpen}
      title={`Watch lap ${moment.lap}${moment.driver ? ` following ${moment.driver}` : ''}`}
    >
      <span className="mono" style={{ width: 30, flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 'var(--fs-xs)' }}>
        L{moment.lap}
      </span>
      <Icon size={13} color={iconColour(moment, colour)} style={{ flexShrink: 0 }} />
      <span style={{ width: 3, height: 14, borderRadius: 1, background: moment.driver ? colour : 'transparent', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }}>{moment.text}</span>
      <Play size={11} className="race-moment__play" />
    </div>
  );
};

/** Who led every lap, coloured by team, with SC/VSC/red flag periods drawn above. */
const LeaderStrip: React.FC<{
  data: RaceMoments;
  width: number;
  colourOf: (driver: string | null | undefined) => string;
  onLap: (lap: number) => void;
}> = ({ data, width, colourOf, onLap }) => {
  const n = data.total_laps;
  const cell = width / Math.max(n, 1);
  const x = (lap: number) => (lap - 1) * cell;
  const tickEvery = n > 40 ? 10 : 5;

  return (
    <svg width={width} height={STRIP_HEIGHT} style={{ display: 'block', cursor: 'pointer', flexShrink: 0 }}>
      {data.periods.map(p => (
        <rect
          key={`${p.kind}-${p.start_lap}`}
          x={x(p.start_lap)}
          y={0}
          width={(p.end_lap - p.start_lap + 1) * cell}
          height={4}
          rx={1}
          fill={getTrackStatusColour(p.kind)}
        >
          <title>
            {p.kind === 'sc' ? 'Safety car' : p.kind === 'vsc' ? 'VSC' : 'Red flag'}, lap{' '}
            {p.start_lap === p.end_lap ? p.start_lap : `${p.start_lap}–${p.end_lap}`}
          </title>
        </rect>
      ))}
      {data.leaders.map((driver, i) => (
        <rect
          key={i}
          x={x(i + 1)}
          y={6}
          width={Math.max(cell - (cell > 4 ? 1 : 0), 1)}
          height={12}
          fill={colourOf(driver)}
          onClick={() => onLap(i + 1)}
        >
          <title>{`Lap ${i + 1}${driver ? ` · ${driver} leads` : ''} — click to watch`}</title>
        </rect>
      ))}
      {Array.from({ length: Math.floor(n / tickEvery) }, (_, k) => (k + 1) * tickEvery).map(lap => (
        <text
          key={lap}
          x={x(lap) + cell / 2}
          y={STRIP_HEIGHT - 1}
          textAnchor="middle"
          fontSize={9}
          fill="var(--text-tertiary)"
          style={{ pointerEvents: 'none' }}
        >
          {lap}
        </text>
      ))}
    </svg>
  );
};

registerPanel({
  id: 'race-replay',
  title: 'Race Moments',
  category: 'session',
  Component: RaceMomentsPanel,
});

export default RaceMomentsPanel;
