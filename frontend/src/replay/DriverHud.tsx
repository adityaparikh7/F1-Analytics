/**
 * Race Replay — focused-driver HUD.
 *
 * Live speed, gear, throttle, brake and DRS for one car, plus its place in the race and the
 * gaps either side. Telemetry is fetched per driver on demand and sampled on the replay grid;
 * the readouts update on the clock's per-frame callback, the race context at the tower's rate.
 */

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { getCompoundColour } from '../lib/colours';
import type { DriverHud as Hud, Replay } from './decode';
import { decodeHud } from './decode';
import type { StandingRow } from './replayMath';
import { formatReplayGap, frameAt, holdAt, sampleAt } from './replayMath';
import { iconButtonStyle } from './styles';

interface Props {
  sessionKey: string;
  replay: Replay;
  subscribe: (cb: (t: number) => void) => () => void;
  abbr: string;
  rows: StandingRow[];
  onClose: () => void;
}

interface Loaded {
  key: string;
  hud?: Hud;
  error?: string;
}

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

function Bar({ barRef, colour, label }: { barRef: React.RefObject<HTMLDivElement | null>; colour: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ ...labelStyle, width: 58 }}>{label}</span>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg-raised)', overflow: 'hidden' }}>
        <div ref={barRef} style={{ height: '100%', width: '0%', background: colour, borderRadius: 4 }} />
      </div>
    </div>
  );
}

export const DriverHud: React.FC<Props> = ({ sessionKey, replay, subscribe, abbr, rows, onClose }) => {
  const key = `${sessionKey}:${abbr}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const throttleRef = useRef<HTMLDivElement>(null);
  const brakeRef = useRef<HTMLDivElement>(null);
  const drsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getReplayHud(sessionKey, abbr)
      .then(payload => {
        if (!cancelled) setLoaded({ key, hud: decodeHud(payload) });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoaded({ key, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, abbr, key]);

  const hud = loaded?.key === key ? loaded.hud : undefined;

  useEffect(() => {
    if (!hud) return;
    return subscribe(t => {
      const f = frameAt(replay, t);
      if (speedRef.current) speedRef.current.textContent = String(Math.round(sampleAt(hud.speed, f)));
      if (gearRef.current) {
        const gear = holdAt(hud.gear, f);
        gearRef.current.textContent = gear > 0 ? String(gear) : 'N';
      }
      if (throttleRef.current) throttleRef.current.style.width = `${Math.min(Math.max(sampleAt(hud.throttle, f), 0), 100)}%`;
      if (brakeRef.current) brakeRef.current.style.width = holdAt(hud.brake, f) ? '100%' : '0%';
      if (drsRef.current) {
        const open = holdAt(hud.drs, f) > 0;
        drsRef.current.style.background = open ? 'var(--accent-teal)' : 'var(--bg-raised)';
        drsRef.current.style.color = open ? 'var(--text-inverted)' : 'var(--text-tertiary)';
      }
    });
  }, [hud, subscribe, replay]);

  const idx = rows.findIndex(r => r.driver.abbr === abbr);
  const row = idx >= 0 ? rows[idx] : undefined;
  const behind = idx >= 0 ? rows[idx + 1] : undefined;
  const drv = replay.byAbbr.get(abbr);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span style={{ width: 4, height: 28, borderRadius: 2, background: drv?.colour }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--fs-lg)' }}>
            {row ? `P${row.position} ` : ''}
            {abbr}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            {drv?.team}
            {row && row.state !== 'grid' && ` · Lap ${row.lap}`}
          </div>
        </div>
        <button style={iconButtonStyle} onClick={onClose} title="Clear focus">
          <X size={14} />
        </button>
      </div>

      {loaded?.key === key && loaded.error ? (
        <div className="state-error" style={{ padding: 'var(--space-2)' }}>
          Telemetry unavailable: {loaded.error}
        </div>
      ) : !hud ? (
        <div className="state-loading" style={{ padding: 0 }}>
          <div className="skeleton skeleton--bar" />
          <div className="skeleton skeleton--bar" />
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)' }}>
            <div>
              <div style={labelStyle}>Speed</div>
              <span ref={speedRef} className="mono" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginLeft: 4 }}>km/h</span>
            </div>
            <div>
              <div style={labelStyle}>Gear</div>
              <span ref={gearRef} className="mono" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }} />
            </div>
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
          <Bar barRef={throttleRef} colour="var(--accent-teal)" label="Throttle" />
          <Bar barRef={brakeRef} colour="var(--accent-red)" label="Brake" />
        </>
      )}

      {row && row.state !== 'grid' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 'var(--space-2)',
            paddingTop: 'var(--space-2)',
            borderTop: '1px solid var(--border-default)',
          }}
        >
          <div>
            <div style={labelStyle}>Gap ahead</div>
            <div className="mono" style={{ fontSize: 'var(--fs-md)' }}>
              {row.position === 1 ? 'Leading' : formatReplayGap(row.interval) || '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Gap behind</div>
            <div className="mono" style={{ fontSize: 'var(--fs-md)' }}>
              {behind && behind.state !== 'out' ? formatReplayGap(behind.interval) || '—' : '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Tyre</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)' }}>
              {row.compound && (
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: getCompoundColour(row.compound) }} />
              )}
              {row.compound ? `${row.compound.toLowerCase()} · ${row.tyreAge ?? '?'} laps` : '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Stops</div>
            <div className="mono" style={{ fontSize: 'var(--fs-md)' }}>
              {row.stops}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
