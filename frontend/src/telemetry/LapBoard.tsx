/**
 * Telemetry — the laps being compared, as a timing board: lap and sector times (purple for the
 * best of the compared laps), tyre, and live readouts that follow playback — the gap to the
 * reference at this point of the lap, speed, gear, throttle and brake. Click a lap to follow it.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { getCompoundColour, SECTOR_COLOURS } from '../lib/colours';
import { formatCompound, formatLapTime, formatSectorTime } from '../lib/format';
import type { LapComparison } from '../replay/lapReplay';
import { distanceAt, frameAt, holdAt, sampleAt, timeAtDistance } from '../replay/replayMath';

interface Props {
  comparison: LapComparison;
  subscribe: (cb: (t: number) => void) => () => void;
  focus: string;
  onFocus: (key: string) => void;
}

interface LiveRefs {
  delta?: HTMLSpanElement | null;
  speed?: HTMLSpanElement | null;
  gear?: HTMLSpanElement | null;
  throttle?: HTMLDivElement | null;
  brake?: HTMLDivElement | null;
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`;
}

export const LapBoard: React.FC<Props> = ({ comparison, subscribe, focus, onFocus }) => {
  const { replay, laps, huds, lapTimes } = comparison;
  const live = useRef(new Map<string, LiveRefs>());
  const refKey = laps[0].key;

  const bestSectors = useMemo(() => {
    const best = [Infinity, Infinity, Infinity];
    for (const l of laps) l.trace.sectors.forEach((v, i) => v != null && v < best[i] && (best[i] = v));
    return best;
  }, [laps]);

  useEffect(() => {
    const ref = replay.byAbbr.get(refKey);
    return subscribe(t => {
      const f = frameAt(replay, t);
      const dRef = ref ? distanceAt(replay, ref, t) : 0;
      for (const l of laps) {
        const els = live.current.get(l.key);
        const drv = replay.byAbbr.get(l.key);
        const hud = huds.get(l.key);
        if (!els || !drv || !hud) continue;
        if (els.delta && l.key !== refKey) {
          const at = timeAtDistance(replay, drv, dRef);
          const own = lapTimes.get(l.key)!;
          const delta = at == null ? own - lapTimes.get(refKey)! : at - Math.min(t, lapTimes.get(refKey)!);
          els.delta.textContent = signed(delta);
          els.delta.style.color = delta > 0.0005 ? 'var(--accent-red)' : delta < -0.0005 ? SECTOR_COLOURS.personalBest : 'var(--text-secondary)';
        }
        const finished = t >= lapTimes.get(l.key)!;
        if (els.speed) els.speed.textContent = finished ? '—' : String(Math.round(sampleAt(hud.speed, f)));
        if (els.gear) {
          const gear = holdAt(hud.gear, f);
          els.gear.textContent = finished ? '' : gear > 0 ? String(gear) : 'N';
        }
        if (els.throttle) els.throttle.style.width = finished ? '0%' : `${Math.min(Math.max(sampleAt(hud.throttle, f), 0), 100)}%`;
        if (els.brake) els.brake.style.opacity = !finished && holdAt(hud.brake, f) ? '1' : '0.12';
      }
    });
  }, [replay, laps, huds, lapTimes, subscribe, refKey]);

  const setRef = (key: string, field: keyof LiveRefs) => (el: HTMLElement | null) => {
    const entry = live.current.get(key) ?? {};
    (entry as Record<string, HTMLElement | null>)[field] = el;
    live.current.set(key, entry);
  };

  const refTime = lapTimes.get(refKey)!;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className="mono"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(70px, 1fr) 72px 58px 34px 52px',
          gap: 'var(--space-2)',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-tertiary)',
          padding: '0 var(--space-2) var(--space-1)',
        }}
      >
        <span>Lap</span>
        <span style={{ textAlign: 'right' }}>Time</span>
        <span style={{ textAlign: 'right' }}>Now</span>
        <span style={{ textAlign: 'right' }}>km/h</span>
        <span>Pedals</span>
      </div>
      {laps.map((l, i) => {
        const t = l.trace;
        const own = lapTimes.get(l.key)!;
        return (
          <div
            key={l.key}
            onClick={() => onFocus(l.key)}
            title="Follow this lap on the map"
            style={{
              padding: 'var(--space-2)',
              borderBottom: '1px solid var(--border-default)',
              borderLeft: `3px solid ${l.colour}`,
              background: l.key === focus ? 'var(--bg-active)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(70px, 1fr) 72px 58px 34px 52px',
                gap: 'var(--space-2)',
                alignItems: 'center',
                fontSize: 'var(--fs-sm)',
              }}
            >
              <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                {l.key}
                {i === 0 && (
                  <span className="mono" style={{ marginLeft: 6, fontSize: 9, color: l.colour }}>
                    REF
                  </span>
                )}
              </span>
              <span className="mono" style={{ textAlign: 'right' }}>
                {formatLapTime(own)}
                {i > 0 && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: own > refTime ? 'var(--accent-red)' : SECTOR_COLOURS.personalBest }}>
                    {signed(own - refTime)}
                  </div>
                )}
              </span>
              <span ref={setRef(l.key, 'delta')} className="mono" style={{ textAlign: 'right', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
                {i === 0 ? 'ref' : ''}
              </span>
              <span className="mono" style={{ textAlign: 'right' }}>
                <span ref={setRef(l.key, 'speed')} />
                <span ref={setRef(l.key, 'gear')} style={{ marginLeft: 4, fontSize: 'var(--fs-xs)', color: 'var(--accent-amber)' }} />
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-raised)', overflow: 'hidden' }}>
                  <span ref={setRef(l.key, 'throttle')} style={{ display: 'block', height: '100%', width: '0%', background: 'var(--accent-teal)' }} />
                </span>
                <span
                  ref={setRef(l.key, 'brake')}
                  title="Brake"
                  style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent-red)', opacity: 0.12 }}
                />
              </span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 4, fontSize: 'var(--fs-xs)', alignItems: 'center' }}>
              {t.sectors.map((v, s) => (
                <span key={s} className="mono" style={{ color: v != null && v <= bestSectors[s] ? SECTOR_COLOURS.sessionBest : 'var(--text-secondary)' }}>
                  <span className="text-tertiary">S{s + 1} </span>
                  {formatSectorTime(v)}
                </span>
              ))}
              {t.compound && (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`${t.compound.toLowerCase()}, ${t.tyre_life ?? '?'} laps old`}>
                  <span
                    style={{
                      width: 13,
                      height: 13,
                      borderRadius: '50%',
                      border: `2px solid ${getCompoundColour(t.compound)}`,
                      fontSize: 7,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {formatCompound(t.compound)}
                  </span>
                  <span className="mono text-tertiary">{t.tyre_life ?? ''}</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
