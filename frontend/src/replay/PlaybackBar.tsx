/**
 * Race Replay — transport controls and timeline.
 *
 * The scrubber shows the whole race at once: safety car, VSC and red flag periods as coloured
 * bands, a tick per lap, and the focused driver's pit stops. The playhead moves on the clock's
 * per-frame callback rather than on React renders.
 */

import React, { useEffect, useRef } from 'react';
import { FastForward, Pause, Play, Rewind } from 'lucide-react';
import { getTrackStatusColour } from '../lib/colours';
import type { Replay } from './decode';
import { formatRaceClock } from './replayMath';
import { iconButtonStyle, selectStyle } from './styles';
import type { PlaybackClock } from './usePlaybackClock';
import { PLAYBACK_SPEEDS } from './usePlaybackClock';

export interface TimelineMarker {
  t: number;
  colour: string;
  label: string;
}

interface Props {
  replay: Replay;
  clock: PlaybackClock;
  lapTicks: { lap: number; t: number }[];
  leaderLap: number;
  hasRedFlags: boolean;
  skipRed: boolean;
  onSkipRedChange: (skip: boolean) => void;
  markers?: TimelineMarker[];
}

const BAND_KINDS = new Set(['sc', 'vsc', 'vsc_ending', 'red']);
const BAND_LABELS: Record<string, string> = {
  sc: 'Safety car',
  vsc: 'Virtual safety car',
  vsc_ending: 'VSC ending',
  red: 'Red flag',
};
const SKIP_S = 30;

export const PlaybackBar: React.FC<Props> = ({
  replay,
  clock,
  lapTicks,
  leaderLap,
  hasRedFlags,
  skipRed,
  onSkipRedChange,
  markers = [],
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const span = replay.tEnd - replay.tStart || 1;
  const pct = (t: number) => Math.min(Math.max(((t - replay.tStart) / span) * 100, 0), 100);

  const { subscribe, seek } = clock;
  useEffect(
    () =>
      subscribe(t => {
        const p = `${Math.min(Math.max(((t - replay.tStart) / span) * 100, 0), 100)}%`;
        if (headRef.current) headRef.current.style.left = p;
        if (fillRef.current) fillRef.current.style.width = p;
      }),
    [subscribe, replay, span]
  );

  const seekToPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const k = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    seek(replay.tStart + k * span);
  };

  const lapStart = (lap: number) => (lap <= 1 ? replay.raceStart : lapTicks.find(l => l.lap === lap - 1)?.t);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button style={iconButtonStyle} onClick={() => clock.nudge(-SKIP_S)} title={`Back ${SKIP_S}s (←)`}>
          <Rewind size={14} />
        </button>
        <button
          style={{ ...iconButtonStyle, width: 40, background: 'var(--bg-active)' }}
          onClick={clock.toggle}
          title={clock.playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {clock.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button style={iconButtonStyle} onClick={() => clock.nudge(SKIP_S)} title={`Forward ${SKIP_S}s (→)`}>
          <FastForward size={14} />
        </button>
        <select
          style={selectStyle}
          value={clock.speed}
          onChange={e => clock.setSpeed(Number(e.target.value))}
          title="Playback speed"
        >
          {PLAYBACK_SPEEDS.map(s => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>

        <span className="mono" style={{ fontSize: 'var(--fs-md)', fontWeight: 600, minWidth: 64, textAlign: 'right' }}>
          {formatRaceClock(replay, clock.time)}
        </span>
        <span className="mono" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          LAP <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{leaderLap}</span>/{replay.totalLaps}
        </span>

        <select
          style={selectStyle}
          value=""
          onChange={e => {
            const t = lapStart(Number(e.target.value));
            if (t != null) seek(t - 2);
          }}
          title="Jump to the start of a lap"
        >
          <option value="" disabled>
            Jump to lap…
          </option>
          {Array.from({ length: replay.totalLaps }, (_, i) => i + 1).map(lap => (
            <option key={lap} value={lap}>
              Lap {lap}
            </option>
          ))}
        </select>

        {hasRedFlags && (
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', cursor: 'pointer' }}
            title="Jump over the time cars spend stopped in the pit lane"
          >
            <input type="checkbox" checked={skipRed} onChange={e => onSkipRedChange(e.target.checked)} />
            Skip red-flag stoppages
          </label>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
          Space play/pause · ←/→ {SKIP_S}s
        </span>
      </div>

      <div
        ref={barRef}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekToPointer(e);
        }}
        onPointerMove={e => {
          if (e.buttons & 1) seekToPointer(e);
        }}
        style={{ position: 'relative', height: 38, cursor: 'pointer', touchAction: 'none' }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 12,
            height: 8,
            borderRadius: 4,
            background: 'var(--bg-raised)',
            overflow: 'hidden',
          }}
        >
          <div
            ref={fillRef}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--bg-active)' }}
          />
          {replay.trackStatus
            .filter(iv => BAND_KINDS.has(iv.kind))
            .map(iv => (
              <div
                key={`${iv.kind}-${iv.start_t}`}
                title={BAND_LABELS[iv.kind]}
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${pct(iv.start_t)}%`,
                  width: `${Math.max(pct(iv.end_t) - pct(iv.start_t), 0.3)}%`,
                  background: getTrackStatusColour(iv.kind),
                  opacity: 0.75,
                }}
              />
            ))}
        </div>

        {lapTicks.map(({ lap, t }) => (
          <div
            key={lap}
            style={{
              position: 'absolute',
              left: `${pct(t)}%`,
              top: 22,
              width: 1,
              height: lap % 10 === 0 ? 7 : 3,
              background: lap % 10 === 0 ? 'var(--text-tertiary)' : 'var(--border-strong)',
            }}
          />
        ))}
        {lapTicks
          .filter(({ lap }) => lap % 10 === 0)
          .map(({ lap, t }) => (
            <span
              key={`label-${lap}`}
              className="mono"
              style={{
                position: 'absolute',
                left: `${pct(t)}%`,
                top: 28,
                transform: 'translateX(-50%)',
                fontSize: 9,
                color: 'var(--text-tertiary)',
                pointerEvents: 'none',
              }}
            >
              L{lap}
            </span>
          ))}

        {markers.map(m => (
          <div
            key={`${m.label}-${m.t}`}
            title={m.label}
            style={{
              position: 'absolute',
              left: `${pct(m.t)}%`,
              top: 3,
              width: 7,
              height: 7,
              marginLeft: -3.5,
              borderRadius: '50%',
              background: m.colour,
              border: '1px solid var(--bg-page)',
            }}
          />
        ))}

        <div
          ref={headRef}
          style={{
            position: 'absolute',
            top: 7,
            width: 2,
            height: 18,
            marginLeft: -1,
            borderRadius: 1,
            background: 'var(--text-primary)',
            boxShadow: 'var(--shadow-md)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};
