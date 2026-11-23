/**
 * Telemetry — choose the laps to compare.
 *
 * Drivers are listed fastest first with their best lap; pick one to see all of their timed laps
 * with sector times (purple: best of the session, green: their own best), tyre and age, and
 * flags for pit, safety-car and yellow-flag laps. Click laps to add or remove them (up to four);
 * the first lap is the reference the others are compared against.
 */

import React, { useMemo, useState } from 'react';
import { Plus, Star, X } from 'lucide-react';
import type { LapData } from '../lib/api';
import { ensureReadable, getCompoundColour, getDriverColour, SECTOR_COLOURS } from '../lib/colours';
import { formatCompound, formatLapTime, formatSectorTime } from '../lib/format';
import { cardTitleStyle, iconButtonStyle, toggleStyle } from '../replay/styles';
import { bestLaps, lapFlags, MAX_LAPS, SLOW_FACTOR } from './lapUtils';
import type { LapSpec } from './useLapTraces';
import { lapKey } from './useLapTraces';

interface Props {
  laps: LapData[];
  selected: LapSpec[];
  colours: Map<string, string>;
  /** Per selected lap: still loading, or the error that stopped it. */
  loading: Set<string>;
  errors: Map<string, string>;
  onChange: (next: LapSpec[]) => void;
}

export const LapPicker: React.FC<Props> = ({ laps, selected, colours, loading, errors, onChange }) => {
  const drivers = useMemo(() => bestLaps(laps), [laps]);
  const [chosenDriver, setChosenDriver] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'lap' | 'time'>('lap');
  const [hideSlow, setHideSlow] = useState(true);
  const focused = chosenDriver ?? selected[0]?.driver ?? drivers[0]?.driver ?? null;

  const sessionBestSectors = useMemo(() => {
    const best = [Infinity, Infinity, Infinity];
    for (const lap of laps) {
      [lap.sector1_time, lap.sector2_time, lap.sector3_time].forEach((v, i) => {
        if (v != null && v < best[i]) best[i] = v;
      });
    }
    return best;
  }, [laps]);

  const driverLaps = useMemo(() => {
    const own = laps.filter(l => l.driver === focused && l.lap_time != null);
    const best = Math.min(...own.map(l => l.lap_time as number));
    const personal = [Infinity, Infinity, Infinity];
    for (const lap of own) {
      [lap.sector1_time, lap.sector2_time, lap.sector3_time].forEach((v, i) => {
        if (v != null && v < personal[i]) personal[i] = v;
      });
    }
    const shown = hideSlow ? own.filter(l => (l.lap_time as number) <= best * SLOW_FACTOR) : own;
    shown.sort((a, b) => (sortBy === 'lap' ? a.lap_number - b.lap_number : (a.lap_time as number) - (b.lap_time as number)));
    return { rows: shown, best, personal, hidden: own.length - shown.length };
  }, [laps, focused, sortBy, hideSlow]);

  const isSelected = (driver: string, lap: number) => selected.some(s => s.driver === driver && s.lap === lap);

  const toggle = (spec: LapSpec) => {
    if (isSelected(spec.driver, spec.lap)) onChange(selected.filter(s => !(s.driver === spec.driver && s.lap === spec.lap)));
    else if (selected.length < MAX_LAPS) onChange([...selected, spec]);
    else onChange([...selected.slice(0, MAX_LAPS - 1), spec]);
  };

  const addBest = (driver: string) => {
    const best = drivers.find(d => d.driver === driver)?.best;
    if (best && !isSelected(driver, best.lap_number)) toggle({ driver, lap: best.lap_number });
  };

  const teammate = useMemo(() => {
    const me = drivers.find(d => d.driver === focused);
    return me?.team ? drivers.find(d => d.team === me.team && d.driver !== me.driver)?.driver ?? null : null;
  }, [drivers, focused]);

  const sessionBest = drivers[0]?.best.lap_time ?? null;

  const sectorColour = (v: number | null, i: number) => {
    if (v == null) return 'var(--text-tertiary)';
    if (v <= sessionBestSectors[i]) return SECTOR_COLOURS.sessionBest;
    if (v <= driverLaps.personal[i]) return SECTOR_COLOURS.personalBest;
    return 'var(--text-secondary)';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {/* Selected laps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span style={{ ...cardTitleStyle, marginBottom: 0 }}>Comparing</span>
        {selected.length === 0 && (
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-tertiary)' }}>Pick a lap below to start</span>
        )}
        {selected.map((s, i) => {
          const key = lapKey(s);
          const lap = laps.find(l => l.driver === s.driver && l.lap_number === s.lap);
          const colour = colours.get(key) ?? 'var(--text-secondary)';
          return (
            <span
              key={key}
              className="mono"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 6px 3px 8px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${i === 0 ? colour : 'var(--border-default)'}`,
                background: 'var(--bg-raised)',
                fontSize: 'var(--fs-xs)',
              }}
              title={errors.get(key) ?? (loading.has(key) ? 'Loading telemetry…' : undefined)}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colour }} />
              <b>{key}</b>
              <span className="text-secondary">{formatLapTime(lap?.lap_time)}</span>
              {i === 0 ? (
                <span style={{ color: colour, fontWeight: 700 }}>REF</span>
              ) : (
                <button
                  style={{ ...iconButtonStyle, width: 20, height: 20, border: 'none', background: 'transparent' }}
                  onClick={() => onChange([s, ...selected.filter((_, j) => j !== i)])}
                  title="Make this the reference lap"
                >
                  <Star size={11} />
                </button>
              )}
              {loading.has(key) && <span className="text-tertiary">…</span>}
              {errors.has(key) && <span style={{ color: 'var(--accent-red)' }}>!</span>}
              <button
                style={{ ...iconButtonStyle, width: 20, height: 20, border: 'none', background: 'transparent' }}
                onClick={() => toggle(s)}
                title="Remove"
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {drivers.length >= 2 && (
            <button
              style={toggleStyle(false)}
              onClick={() =>
                onChange(drivers.slice(0, 2).map(d => ({ driver: d.driver, lap: d.best.lap_number })))
              }
              title="The two fastest drivers' best laps"
            >
              Fastest two
            </button>
          )}
          {focused && teammate && (
            <button style={toggleStyle(false)} onClick={() => addBest(teammate)} title={`Add ${teammate}'s best lap`}>
              + Teammate ({teammate})
            </button>
          )}
          {selected.length > 0 && (
            <button style={toggleStyle(false)} onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </span>
      </div>

      {/* Drivers, fastest first */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {drivers.map((d, i) => {
          const colour = ensureReadable(getDriverColour(d.driver, d.team));
          const active = d.driver === focused;
          return (
            <span
              key={d.driver}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border-default)'}`,
                background: active ? 'var(--bg-active)' : 'var(--bg-raised)',
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setChosenDriver(d.driver)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', fontSize: 'var(--fs-xs)' }}
                title={`${d.driver}: best lap ${formatLapTime(d.best.lap_time)} (lap ${d.best.lap_number}) — show all laps`}
              >
                <span style={{ width: 3, height: 14, borderRadius: 1, background: colour }} />
                <b style={{ color: 'var(--text-primary)' }}>{d.driver}</b>
                <span className="mono" style={{ color: 'var(--text-tertiary)' }}>
                  {i === 0 || sessionBest == null
                    ? formatLapTime(d.best.lap_time)
                    : `+${((d.best.lap_time as number) - sessionBest).toFixed(3)}`}
                </span>
              </button>
              <button
                onClick={() => addBest(d.driver)}
                style={{ padding: '3px 6px', borderLeft: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                title={`Add ${d.driver}'s best lap`}
              >
                <Plus size={11} />
              </button>
            </span>
          );
        })}
      </div>

      {/* The chosen driver's laps */}
      {focused && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, whiteSpace: 'nowrap' }} title="Click a lap to add or remove it">
              {focused}'s laps
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button style={{ ...toggleStyle(sortBy === 'lap'), height: 24, whiteSpace: 'nowrap' }} onClick={() => setSortBy('lap')} title="Sort by lap number">
                Lap #
              </button>
              <button style={{ ...toggleStyle(sortBy === 'time'), height: 24, whiteSpace: 'nowrap' }} onClick={() => setSortBy('time')} title="Fastest first">
                Fastest
              </button>
              <button
                style={{ ...toggleStyle(hideSlow), height: 24, whiteSpace: 'nowrap' }}
                onClick={() => setHideSlow(v => !v)}
                title="Hide laps more than 7% slower than this driver's best (out-laps, in-laps, traffic)"
              >
                Hide slow{driverLaps.hidden ? ` (${driverLaps.hidden})` : ''}
              </button>
            </span>
          </div>
          <div style={{ maxHeight: 210, overflowY: 'auto', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
            <table className="data-table data-table--compact" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>Lap</th>
                  <th>Time</th>
                  <th>Δ best</th>
                  <th>S1</th>
                  <th>S2</th>
                  <th>S3</th>
                  <th>Tyre</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {driverLaps.rows.map(lap => {
                  const key = lapKey({ driver: lap.driver, lap: lap.lap_number });
                  const picked = isSelected(lap.driver, lap.lap_number);
                  const delta = (lap.lap_time as number) - driverLaps.best;
                  return (
                    <tr
                      key={lap.lap_number}
                      onClick={() => toggle({ driver: lap.driver, lap: lap.lap_number })}
                      style={{
                        cursor: 'pointer',
                        background: picked ? 'var(--bg-active)' : undefined,
                        boxShadow: picked ? `inset 3px 0 0 ${colours.get(key) ?? 'var(--text-primary)'}` : undefined,
                      }}
                      title={picked ? 'Remove from the comparison' : 'Add to the comparison'}
                    >
                      <td className="mono">{lap.lap_number}</td>
                      <td className="mono" style={{ fontWeight: delta === 0 ? 700 : 400 }}>
                        {formatLapTime(lap.lap_time)}
                      </td>
                      <td className="mono" style={{ color: delta === 0 ? SECTOR_COLOURS.personalBest : 'var(--text-tertiary)' }}>
                        {delta === 0 ? 'best' : `+${delta.toFixed(3)}`}
                      </td>
                      {[lap.sector1_time, lap.sector2_time, lap.sector3_time].map((v, i) => (
                        <td key={i} className="mono" style={{ color: sectorColour(v, i) }}>
                          {formatSectorTime(v)}
                        </td>
                      ))}
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {lap.compound && (
                            <span
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: '50%',
                                border: `2px solid ${getCompoundColour(lap.compound)}`,
                                fontSize: 7,
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {formatCompound(lap.compound)}
                            </span>
                          )}
                          <span className="mono text-tertiary" style={{ fontSize: 'var(--fs-xs)' }}>
                            {lap.tyre_life ?? ''}
                          </span>
                        </span>
                      </td>
                      <td>
                        {lapFlags(lap).map(f => (
                          <span key={f} className="mono" style={{ fontSize: 9, color: 'var(--text-tertiary)', marginRight: 4 }}>
                            {f}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
                {driverLaps.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ color: 'var(--text-tertiary)' }}>
                      No timed laps
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
