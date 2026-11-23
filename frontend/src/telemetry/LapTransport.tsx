/**
 * Telemetry — playback controls for a lap comparison: play/pause, slow motion, and a scrubber
 * marked with the reference lap's sectors and where each lap crossed the line.
 */

import React, { useEffect, useRef } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { formatLapTime } from '../lib/format';
import type { LapComparison } from '../replay/lapReplay';
import { iconButtonStyle, selectStyle } from '../replay/styles';
import type { PlaybackClock } from '../replay/usePlaybackClock';
import { LAP_SPEEDS } from './lapUtils';

interface Props {
  comparison: LapComparison;
  clock: PlaybackClock;
}

export const LapTransport: React.FC<Props> = ({ comparison, clock }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const { replay, laps, lapTimes } = comparison;
  const span = replay.tEnd - replay.tStart || 1;
  const pct = (t: number) => Math.min(Math.max(((t - replay.tStart) / span) * 100, 0), 100);
  const refLap = laps[0].trace;
  const sectorTimes: number[] = [];
  if (refLap.sectors[0] != null) {
    sectorTimes.push(refLap.sectors[0]);
    if (refLap.sectors[1] != null) sectorTimes.push(refLap.sectors[0] + refLap.sectors[1]);
  }

  const { subscribe, seek } = clock;
  useEffect(
    () =>
      subscribe(t => {
        const p = `${Math.min(Math.max(((t - replay.tStart) / span) * 100, 0), 100)}%`;
        if (headRef.current) headRef.current.style.left = p;
        if (fillRef.current) fillRef.current.style.width = p;
        if (timeRef.current) timeRef.current.textContent = formatLapTime(Math.max(t, 0));
      }),
    [subscribe, replay, span]
  );

  const seekToPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    seek(replay.tStart + Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * span);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <button style={iconButtonStyle} onClick={() => seek(replay.tStart)} title="Back to the line">
        <RotateCcw size={14} />
      </button>
      <button
        style={{ ...iconButtonStyle, width: 40, background: 'var(--bg-active)' }}
        onClick={clock.toggle}
        title={clock.playing ? 'Pause (Space)' : 'Play (Space)'}
      >
        {clock.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <select style={selectStyle} value={clock.speed} onChange={e => clock.setSpeed(Number(e.target.value))} title="Playback speed">
        {LAP_SPEEDS.map(s => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <span className="mono" style={{ fontSize: 'var(--fs-md)', fontWeight: 600, minWidth: 74, textAlign: 'right' }}>
        <span ref={timeRef}>0.000</span>
      </span>
      <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
        / {formatLapTime(lapTimes.get(laps[0].key))}
      </span>

      <div
        ref={barRef}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekToPointer(e);
        }}
        onPointerMove={e => {
          if (e.buttons & 1) seekToPointer(e);
        }}
        style={{ position: 'relative', flex: '1 1 240px', height: 30, cursor: 'pointer', touchAction: 'none' }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 11,
            height: 8,
            borderRadius: 4,
            background: 'var(--bg-raised)',
            overflow: 'hidden',
          }}
        >
          <div ref={fillRef} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--bg-active)' }} />
        </div>
        {sectorTimes.map((t, i) => (
          <React.Fragment key={t}>
            <div style={{ position: 'absolute', left: `${pct(t)}%`, top: 8, width: 1, height: 14, background: 'var(--border-strong)' }} />
            <span
              className="mono"
              style={{ position: 'absolute', left: `${pct(t)}%`, top: 21, transform: 'translateX(-50%)', fontSize: 8, color: 'var(--text-tertiary)' }}
            >
              S{i + 1}|S{i + 2}
            </span>
          </React.Fragment>
        ))}
        {laps.map(l => {
          const t = lapTimes.get(l.key)!;
          return (
            <div
              key={l.key}
              title={`${l.key} crosses the line: ${formatLapTime(t)}`}
              style={{
                position: 'absolute',
                left: `${pct(t)}%`,
                top: 2,
                width: 7,
                height: 7,
                marginLeft: -3.5,
                borderRadius: '50%',
                background: l.colour,
                border: '1px solid var(--bg-page)',
              }}
            />
          );
        })}
        <div
          ref={headRef}
          style={{
            position: 'absolute',
            top: 6,
            width: 2,
            height: 18,
            marginLeft: -1,
            borderRadius: 1,
            background: 'var(--text-primary)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};
