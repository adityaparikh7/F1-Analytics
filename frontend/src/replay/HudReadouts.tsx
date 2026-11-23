/**
 * Race Replay — live telemetry readouts for one car.
 *
 * Speed, gear, RPM, throttle, brake and DRS, updated on the clock's per-frame callback (DOM writes
 * through refs, no React renders). Used by the single-driver card and, twice, by head-to-head.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { DriverHud as Hud, Replay } from './decode';
import { frameAt, holdAt, sampleAt } from './replayMath';
import { hudLabelStyle } from './styles';

function Bar({ barRef, colour, label }: { barRef: React.RefObject<HTMLDivElement | null>; colour: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ ...hudLabelStyle, width: 58 }}>{label}</span>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg-raised)', overflow: 'hidden' }}>
        <div ref={barRef} style={{ height: '100%', width: '0%', background: colour, borderRadius: 4 }} />
      </div>
    </div>
  );
}

export const HudReadouts: React.FC<{
  replay: Replay;
  hud: Hud;
  subscribe: (cb: (t: number) => void) => () => void;
  /** Smaller numbers, for two side by side. */
  compact?: boolean;
}> = ({ replay, hud, subscribe, compact = false }) => {
  const speedRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const rpmRef = useRef<HTMLSpanElement>(null);
  const revRef = useRef<HTMLDivElement>(null);
  const throttleRef = useRef<HTMLDivElement>(null);
  const brakeRef = useRef<HTMLDivElement>(null);
  const drsRef = useRef<HTMLSpanElement>(null);

  // Rev bar scaled to this car's own peak, so it reads the same across engine eras.
  const rpmMax = useMemo(() => {
    if (!hud.rpm) return 0;
    let max = 0;
    for (const v of hud.rpm) if (v > max) max = v;
    return max;
  }, [hud]);

  useEffect(
    () =>
      subscribe(t => {
        const f = frameAt(replay, t);
        if (speedRef.current) speedRef.current.textContent = String(Math.round(sampleAt(hud.speed, f)));
        if (gearRef.current) {
          const gear = holdAt(hud.gear, f);
          gearRef.current.textContent = gear > 0 ? String(gear) : 'N';
        }
        if (hud.rpm) {
          const rpm = sampleAt(hud.rpm, f);
          if (rpmRef.current) rpmRef.current.textContent = Math.round(rpm).toLocaleString();
          if (revRef.current && rpmMax > 0) revRef.current.style.width = `${Math.min((rpm / rpmMax) * 100, 100)}%`;
        }
        if (throttleRef.current) throttleRef.current.style.width = `${Math.min(Math.max(sampleAt(hud.throttle, f), 0), 100)}%`;
        if (brakeRef.current) brakeRef.current.style.width = holdAt(hud.brake, f) ? '100%' : '0%';
        if (drsRef.current) {
          const open = holdAt(hud.drs, f) > 0;
          drsRef.current.style.background = open ? 'var(--accent-teal)' : 'var(--bg-raised)';
          drsRef.current.style.color = open ? 'var(--text-inverted)' : 'var(--text-tertiary)';
        }
      }),
    [hud, subscribe, replay, rpmMax]
  );

  const big = compact ? 22 : 30;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          rowGap: 'var(--space-2)',
          columnGap: compact ? 'var(--space-3)' : 'var(--space-4)',
        }}
      >
        <div>
          <div style={hudLabelStyle}>Speed</div>
          <span ref={speedRef} className="mono" style={{ fontSize: big, fontWeight: 700, lineHeight: 1 }} />
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginLeft: 4 }}>km/h</span>
        </div>
        <div>
          <div style={hudLabelStyle}>Gear</div>
          <span ref={gearRef} className="mono" style={{ fontSize: big, fontWeight: 700, lineHeight: 1 }} />
        </div>
        {hud.rpm && (
          <div>
            <div style={hudLabelStyle}>RPM</div>
            <span ref={rpmRef} className="mono" style={{ fontSize: compact ? 14 : 18, fontWeight: 600, lineHeight: 1.4 }} />
          </div>
        )}
        {hud.hasDrs && (
          <span
            ref={drsRef}
            className="mono"
            style={{
              marginLeft: 'auto',
              padding: '2px 8px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-xs)',
              fontWeight: 700,
              transition: 'background var(--transition-fast)',
            }}
          >
            DRS
          </span>
        )}
      </div>
      {hud.rpm && <Bar barRef={revRef} colour="var(--accent-amber)" label="Revs" />}
      <Bar barRef={throttleRef} colour="var(--accent-teal)" label="Throttle" />
      <Bar barRef={brakeRef} colour="var(--accent-red)" label="Brake" />
    </div>
  );
};
