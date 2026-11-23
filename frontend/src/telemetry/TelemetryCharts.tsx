/**
 * Telemetry — the compared laps' channels against distance: time delta to the reference, speed,
 * throttle, brake, gear and RPM, stacked on one distance axis with corner and sector markers.
 *
 * Each lap's position at the playback time is drawn as a cursor (updated every frame, outside
 * React), so the charts follow the replay on the map. Hover to read every lap at one point; click
 * to jump playback there; drag to zoom into a stretch of track (double-click, or "Lap", resets).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SECTOR_COLOURS } from '../lib/colours';
import type { LapComparison, LapSeries } from '../replay/lapReplay';
import { interp } from '../replay/lapReplay';
import { toggleStyle } from '../replay/styles';
import { useElementSize } from '../replay/useElementSize';

type ChannelId = 'delta' | 'speed' | 'throttle' | 'brake' | 'gear' | 'rpm';

interface ChannelDef {
  id: ChannelId;
  label: string;
  unit: string;
  height: number;
}

const CHANNELS: ChannelDef[] = [
  { id: 'delta', label: 'Delta', unit: 's', height: 100 },
  { id: 'speed', label: 'Speed', unit: 'km/h', height: 160 },
  { id: 'throttle', label: 'Throttle', unit: '%', height: 72 },
  { id: 'brake', label: 'Brake', unit: '', height: 0 },
  { id: 'gear', label: 'Gear', unit: '', height: 64 },
  { id: 'rpm', label: 'RPM', unit: '', height: 72 },
];
const DEFAULT_CHANNELS: ChannelId[] = ['delta', 'speed', 'throttle', 'brake', 'gear'];
const STORAGE_KEY = 'pitwall_telemetry_channels';

const GUTTER_L = 48;
const GUTTER_R = 12;
const AXIS_TOP = 20;
const AXIS_BOTTOM = 20;
const BAND_GAP = 14;
const PAD = 4;
const LANE_H = 8;
const DRAG_PX = 4;
const MIN_RANGE_M = 50;
const LABEL_GAP_PX = 20;

interface Band {
  def: ChannelDef;
  top: number;
  h: number;
  lo: number;
  hi: number;
}

function loadChannels(): Set<ChannelId> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) return new Set(CHANNELS.map(c => c.id).filter(id => saved.includes(id)));
  } catch {
    // Unreadable storage: fall back to the defaults.
  }
  return new Set(DEFAULT_CHANNELS);
}

function saveChannels(channels: Set<ChannelId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...channels]));
  } catch {
    // Private mode: the choice just doesn't stick.
  }
}

/** Channel samples of one lap against its own (normalised) distance. */
function channelSeries(comparison: LapComparison, key: string, id: ChannelId): [ArrayLike<number>, ArrayLike<number>] {
  if (id === 'delta') return [comparison.delta.d, comparison.delta.byLap.get(key)!];
  const ser = comparison.series.get(key) as LapSeries;
  const ys = id === 'speed' ? ser.speed : id === 'throttle' ? ser.throttle : id === 'gear' ? ser.gear : id === 'rpm' ? ser.rpm : ser.brake;
  return [ser.d, ys];
}

/** Index of the last element ≤ x (0 if none). */
function floorIndex(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (x <= xs[0]) return 0;
  if (x >= xs[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

function formatValue(id: ChannelId, v: number): string {
  if (id === 'delta') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
  if (id === 'rpm') return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

interface Props {
  comparison: LapComparison;
  subscribe: (cb: (t: number) => void) => () => void;
  /** Lap whose time a click seeks to (that lap is at the clicked point after the seek). */
  focus: string;
  onSeek: (t: number) => void;
  /** Zoomed distance range (reference metres), or null for the whole lap. */
  range: [number, number] | null;
  onRangeChange: (range: [number, number] | null) => void;
}

export const TelemetryCharts: React.FC<Props> = ({ comparison, subscribe, focus, onSeek, range, onRangeChange }) => {
  const { laps, series, lapLength, sectorEnds, replay } = comparison;
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [channels, setChannels] = useState<Set<ChannelId>>(loadChannels);
  const [hover, setHover] = useState<{ x: number; d: number } | null>(null);
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const cursors = useRef(new Map<string, SVGLineElement | null>());
  const dots = useRef(new Map<string, SVGCircleElement | null>());

  const width = size.width;
  const plotW = Math.max(width - GUTTER_L - GUTTER_R, 1);
  const [d0, d1] = range ?? [0, lapLength];
  const refKey = laps[0].key;

  const toggleChannel = (id: ChannelId) => {
    const next = new Set(channels);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChannels(next);
    saveChannels(next);
  };

  // Sector and corner positions along the reference lap.
  const sectors = useMemo(() => {
    const bounds = [0, ...sectorEnds, lapLength];
    return bounds.slice(0, -1).map((a, i) => ({ label: `S${i + 1}`, from: a, to: bounds[i + 1] }));
  }, [sectorEnds, lapLength]);

  const corners = useMemo(() => {
    const ref = series.get(refKey)!;
    return replay.corners.map(c => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < ref.x.length; i++) {
        const dist = (ref.x[i] - c.x) ** 2 + (ref.y[i] - c.y) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return { label: `${c.number}${c.letter}`, d: ref.d[best] };
    });
  }, [replay, series, refKey]);

  // Bands, with value ranges fitted to the visible stretch.
  const layout = useMemo(() => {
    let top = AXIS_TOP;
    const bands: Band[] = [];
    for (const def of CHANNELS) {
      if (!channels.has(def.id)) continue;
      let lo = Infinity;
      let hi = -Infinity;
      if (def.id === 'brake') {
        lo = 0;
        hi = 1;
      } else if (def.id === 'throttle') {
        lo = 0;
        hi = 100;
      } else if (def.id === 'gear') {
        lo = 1;
        hi = 8;
      } else {
        for (const l of laps) {
          if (def.id === 'delta' && l.key === refKey) continue;
          const [xs, ys] = channelSeries(comparison, l.key, def.id);
          for (let i = floorIndex(xs, d0); i < xs.length && xs[i] <= d1; i++) {
            if (!Number.isFinite(ys[i])) continue;
            lo = Math.min(lo, ys[i]);
            hi = Math.max(hi, ys[i]);
          }
        }
        if (def.id === 'delta') {
          lo = Math.min(lo, 0);
          hi = Math.max(hi, 0);
          if (!Number.isFinite(lo) || hi - lo < 0.1) {
            lo = Math.min(lo, -0.05);
            hi = Math.max(hi, 0.05);
          }
        }
        if (!Number.isFinite(lo)) {
          lo = 0;
          hi = 1;
        }
        const pad = (hi - lo || 1) * 0.06;
        lo -= pad;
        hi += pad;
      }
      const h = def.id === 'brake' ? laps.length * LANE_H + 2 * PAD : def.height;
      bands.push({ def, top, h, lo, hi });
      top += h + BAND_GAP;
    }
    return { bands, height: top - BAND_GAP + AXIS_BOTTOM };
  }, [channels, comparison, laps, refKey, d0, d1]);

  const xOf = useMemo(() => {
    const span = d1 - d0 || 1;
    return (d: number) => GUTTER_L + ((d - d0) / span) * plotW;
  }, [d0, d1, plotW]);
  const yOf = (b: Band, v: number) => b.top + PAD + (1 - (v - b.lo) / (b.hi - b.lo || 1)) * (b.h - 2 * PAD);
  const dOf = (x: number) => d0 + Math.min(Math.max((x - GUTTER_L) / plotW, 0), 1) * (d1 - d0);

  // The traces: the reference last so it sits on top in the colour that names it.
  const traces = useMemo(() => {
    if (width <= 0) return null;
    const y = (b: Band, v: number) => b.top + PAD + (1 - (v - b.lo) / (b.hi - b.lo || 1)) * (b.h - 2 * PAD);
    const out: React.ReactNode[] = [];
    const ordered = [...laps].reverse();
    for (const b of layout.bands) {
      if (b.def.id === 'brake') {
        laps.forEach((l, lane) => {
          const ser = series.get(l.key)!;
          const laneTop = b.top + PAD + lane * LANE_H + 1;
          let start = -1;
          for (let i = 0; i <= ser.d.length; i++) {
            const on = i < ser.d.length && ser.brake[i] > 0;
            if (on && start < 0) start = i;
            if (!on && start >= 0) {
              const a = ser.d[start];
              const z = ser.d[Math.min(i, ser.d.length - 1)];
              if (z >= d0 && a <= d1) {
                out.push(
                  <rect
                    key={`brake-${l.key}-${start}`}
                    x={xOf(a)}
                    y={laneTop}
                    width={Math.max(xOf(z) - xOf(a), 1)}
                    height={LANE_H - 2}
                    rx={1}
                    fill={l.colour}
                  />
                );
              }
              start = -1;
            }
          }
        });
        continue;
      }
      for (const l of ordered) {
        if (b.def.id === 'delta' && l.key === refKey) {
          out.push(
            <line
              key={`delta-ref`}
              x1={GUTTER_L}
              x2={GUTTER_L + plotW}
              y1={y(b, 0)}
              y2={y(b, 0)}
              stroke={l.colour}
              strokeDasharray="4 3"
              strokeWidth={1.2}
            />
          );
          continue;
        }
        const [xs, ys] = channelSeries(comparison, l.key, b.def.id);
        const from = Math.max(floorIndex(xs, d0) - 1, 0);
        let path = '';
        let prevY = 0;
        for (let i = from; i < xs.length; i++) {
          const px = xOf(xs[i]).toFixed(1);
          const py = y(b, ys[i]).toFixed(1);
          if (!path) path = `M${px},${py}`;
          else if (b.def.id === 'gear') path += `H${px}${Number(py) !== prevY ? `V${py}` : ''}`;
          else path += `L${px},${py}`;
          prevY = Number(py);
          if (xs[i] > d1) break;
        }
        out.push(
          <path
            key={`${b.def.id}-${l.key}`}
            d={path}
            fill="none"
            stroke={l.colour}
            strokeWidth={l.key === refKey ? 1.6 : 1.3}
            strokeLinejoin="round"
          />
        );
      }
    }
    return out;
  }, [layout, laps, series, comparison, refKey, xOf, d0, d1, plotW, width]);

  // Per-frame cursors: where each lap is at the playback time.
  useEffect(() => {
    const bands = layout.bands;
    return subscribe(t => {
      for (const l of laps) {
        const ser = series.get(l.key)!;
        const d = interp(ser.t, ser.d, t);
        const visible = d >= d0 && d <= d1;
        const x = xOf(d).toFixed(1);
        const line = cursors.current.get(l.key);
        if (line) {
          line.setAttribute('x1', x);
          line.setAttribute('x2', x);
          line.style.display = visible ? '' : 'none';
        }
        for (const b of bands) {
          const dot = dots.current.get(`${b.def.id}|${l.key}`);
          if (!dot) continue;
          const [xs, ys] = channelSeries(comparison, l.key, b.def.id);
          const v = b.def.id === 'gear' ? ys[floorIndex(xs, d)] : interp(xs, ys, d);
          dot.setAttribute('cx', x);
          dot.setAttribute('cy', (b.top + PAD + (1 - (v - b.lo) / (b.hi - b.lo || 1)) * (b.h - 2 * PAD)).toFixed(1));
          dot.style.display = visible ? '' : 'none';
        }
      }
    });
  }, [subscribe, layout, laps, series, comparison, xOf, d0, d1]);

  const localX = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? e.clientX - rect.left : 0;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x0: localX(e), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const x = Math.min(Math.max(localX(e), GUTTER_L), GUTTER_L + plotW);
    setHover({ x, d: dOf(x) });
    const dr = drag.current;
    if (dr && (dr.moved || Math.abs(x - dr.x0) > DRAG_PX)) {
      dr.moved = true;
      setBrush([dr.x0, x]);
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const dr = drag.current;
    drag.current = null;
    setBrush(null);
    if (!dr) return;
    const x = localX(e);
    if (dr.moved) {
      const a = dOf(Math.min(dr.x0, x));
      const b = dOf(Math.max(dr.x0, x));
      if (b - a >= MIN_RANGE_M) onRangeChange([a, b]);
      return;
    }
    const ser = series.get(focus) ?? series.get(refKey)!;
    onSeek(interp(ser.d, ser.t, dOf(x)));
  };

  const ticks = useMemo(() => {
    const step = niceStep(d1 - d0, Math.max(Math.floor(plotW / 110), 2));
    const out: number[] = [];
    for (let v = Math.ceil(d0 / step) * step; v <= d1; v += step) out.push(v);
    return { step, values: out };
  }, [d0, d1, plotW]);

  const cornerLabels = useMemo(() => {
    const out: { label: string; d: number; x: number; show: boolean }[] = [];
    let lastX = -Infinity;
    for (const c of [...corners].sort((a, b) => a.d - b.d)) {
      if (c.d < d0 || c.d > d1) continue;
      const x = xOf(c.d);
      const show = x - lastX >= LABEL_GAP_PX;
      if (show) lastX = x;
      out.push({ ...c, x, show });
    }
    return out;
  }, [corners, d0, d1, xOf]);

  const zoomedTo = (from: number, to: number) => range != null && Math.abs(range[0] - from) < 1 && Math.abs(range[1] - to) < 1;
  const plotBottom = layout.height - AXIS_BOTTOM;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 2 }} role="group" aria-label="Channels">
          {CHANNELS.map(c => (
            <button key={c.id} style={{ ...toggleStyle(channels.has(c.id)), height: 26 }} onClick={() => toggleChannel(c.id)} aria-pressed={channels.has(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }} role="group" aria-label="Zoom">
          <button style={{ ...toggleStyle(range == null), height: 26 }} onClick={() => onRangeChange(null)} title="Whole lap (double-click the chart)">
            Lap
          </button>
          {sectors.map(s => (
            <button
              key={s.label}
              style={{ ...toggleStyle(zoomedTo(s.from, s.to)), height: 26 }}
              onClick={() => onRangeChange([s.from, s.to])}
              title={`Zoom to sector ${s.label.slice(1)}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>Drag to zoom · click to jump there</span>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', width: '100%', minHeight: 120 }}>
        {width > 0 && layout.bands.length === 0 && (
          <div className="state-empty" style={{ height: 120 }}>
            Pick a channel to plot
          </div>
        )}
        {width > 0 && layout.bands.length > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={layout.height}
            style={{ display: 'block', cursor: brush ? 'col-resize' : 'crosshair', touchAction: 'none', userSelect: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={() => onRangeChange(null)}
          >
            <defs>
              <clipPath id="telemetry-plot">
                <rect x={GUTTER_L} y={0} width={plotW} height={layout.height} />
              </clipPath>
            </defs>

            {/* Sector shading, boundaries and labels. */}
            {sectors.map((s, i) =>
              i % 2 === 1 && s.to >= d0 && s.from <= d1 ? (
                <rect
                  key={s.label}
                  x={Math.max(xOf(s.from), GUTTER_L)}
                  y={AXIS_TOP}
                  width={Math.max(Math.min(xOf(s.to), GUTTER_L + plotW) - Math.max(xOf(s.from), GUTTER_L), 0)}
                  height={plotBottom - AXIS_TOP}
                  fill="var(--bg-raised)"
                  opacity={0.45}
                />
              ) : null
            )}
            {sectors.map(s =>
              s.from > d0 && s.from < d1 ? (
                <line key={`b-${s.label}`} x1={xOf(s.from)} x2={xOf(s.from)} y1={AXIS_TOP - 4} y2={plotBottom} stroke="var(--border-strong)" />
              ) : null
            )}
            {sectors.map(s => {
              const a = Math.max(s.from, d0);
              const b = Math.min(s.to, d1);
              if (b - a <= 0) return null;
              return (
                <text key={`l-${s.label}`} x={xOf(a) + 4} y={10} fontSize={10} fontWeight={600} fill="var(--text-secondary)">
                  {s.label}
                </text>
              );
            })}

            {/* Corners. */}
            {cornerLabels.map(c => (
              <g key={c.label}>
                <line x1={c.x} x2={c.x} y1={AXIS_TOP} y2={plotBottom} stroke="var(--border-default)" strokeDasharray="2 4" />
                {c.show && (
                  <text x={c.x} y={AXIS_TOP - 4} fontSize={9} textAnchor="middle" fill="var(--text-tertiary)" className="mono">
                    {c.label}
                  </text>
                )}
              </g>
            ))}

            {/* Band frames, labels and value axes. */}
            {layout.bands.map(b => (
              <g key={b.def.id}>
                <rect x={GUTTER_L} y={b.top} width={plotW} height={b.h} fill="none" stroke="var(--border-default)" />
                <text x={GUTTER_L + 6} y={b.top + 12} fontSize={10} fontWeight={600} fill="var(--text-tertiary)">
                  {b.def.id === 'delta' ? `Δ to ${refKey} (s)` : `${b.def.label}${b.def.unit ? ` (${b.def.unit})` : ''}`}
                </text>
                {b.def.id === 'brake'
                  ? laps.map((l, lane) => (
                      <text
                        key={l.key}
                        x={GUTTER_L - 6}
                        y={b.top + PAD + lane * LANE_H + LANE_H - 1}
                        fontSize={8}
                        textAnchor="end"
                        fill={l.colour}
                        className="mono"
                      >
                        {l.key.split(' ')[0]}
                      </text>
                    ))
                  : [b.hi, b.lo, ...(b.def.id === 'delta' && yOf(b, 0) > b.top + 18 && yOf(b, 0) < b.top + b.h - 14 ? [0] : [])].map((v, i) => {
                      const yy = b.def.id === 'delta' && i === 2 ? yOf(b, 0) : i === 0 ? b.top + 8 : b.top + b.h - 3;
                      return (
                        <text key={i} x={GUTTER_L - 6} y={yy + (i === 2 ? 3 : 0)} fontSize={9} textAnchor="end" fill="var(--text-tertiary)" className="mono">
                          {formatValue(b.def.id, v)}
                        </text>
                      );
                    })}
              </g>
            ))}

            <g clipPath="url(#telemetry-plot)">{traces}</g>

            {/* Distance axis. */}
            {ticks.values.map(v => (
              <text key={v} x={xOf(v)} y={layout.height - 6} fontSize={9} textAnchor="middle" fill="var(--text-tertiary)" className="mono">
                {ticks.step < 500 ? `${Math.round(v)} m` : `${(v / 1000).toFixed(1)} km`}
              </text>
            ))}

            {/* Playback cursors. */}
            <g pointerEvents="none">
              {laps.map(l => (
                <line
                  key={l.key}
                  ref={el => {
                    cursors.current.set(l.key, el);
                  }}
                  y1={AXIS_TOP}
                  y2={plotBottom}
                  stroke={l.colour}
                  strokeWidth={1}
                  opacity={0.8}
                />
              ))}
              {layout.bands
                .filter(b => b.def.id !== 'brake')
                .flatMap(b =>
                  laps.map(l => (
                    <circle
                      key={`${b.def.id}|${l.key}`}
                      ref={el => {
                        dots.current.set(`${b.def.id}|${l.key}`, el);
                      }}
                      r={3}
                      fill={l.colour}
                      stroke="var(--bg-panel)"
                      strokeWidth={1}
                    />
                  ))
                )}
            </g>

            {hover && !brush && (
              <line x1={hover.x} x2={hover.x} y1={AXIS_TOP} y2={plotBottom} stroke="var(--text-secondary)" strokeDasharray="3 3" pointerEvents="none" />
            )}
            {brush && (
              <rect
                x={Math.min(...brush)}
                y={AXIS_TOP}
                width={Math.abs(brush[1] - brush[0])}
                height={plotBottom - AXIS_TOP}
                fill="var(--text-primary)"
                opacity={0.08}
                stroke="var(--text-secondary)"
                pointerEvents="none"
              />
            )}
          </svg>
        )}
        {hover && !brush && width > 0 && layout.bands.length > 0 && (
          <HoverCard comparison={comparison} d={hover.d} x={hover.x} width={width} />
        )}
      </div>
    </div>
  );
};

/** Every lap's readings at one point of the lap. */
const HoverCard: React.FC<{ comparison: LapComparison; d: number; x: number; width: number }> = ({ comparison, d, x, width }) => {
  const { laps } = comparison;
  const refKey = laps[0].key;
  const at = (key: string, id: ChannelId) => {
    const [xs, ys] = channelSeries(comparison, key, id);
    return id === 'gear' || id === 'brake' ? ys[floorIndex(xs, d)] : interp(xs, ys, d);
  };
  const left = x > width / 2;
  return (
    <div
      className="mono"
      style={{
        position: 'absolute',
        top: AXIS_TOP + 4,
        left: left ? undefined : x + 12,
        right: left ? width - x + 12 : undefined,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: '6px 8px',
        fontSize: 'var(--fs-xs)',
        pointerEvents: 'none',
        zIndex: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>{Math.round(d)} m</div>
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {laps.map(l => {
            const delta = at(l.key, 'delta');
            return (
              <tr key={l.key}>
                <td style={{ paddingRight: 8, color: l.colour, fontWeight: 700 }}>{l.key}</td>
                <td style={{ paddingRight: 8, textAlign: 'right' }}>{Math.round(at(l.key, 'speed'))}</td>
                <td style={{ paddingRight: 8, color: 'var(--accent-amber)' }}>G{Math.round(at(l.key, 'gear'))}</td>
                <td style={{ paddingRight: 8, textAlign: 'right', color: 'var(--accent-teal)' }}>{Math.round(at(l.key, 'throttle'))}%</td>
                <td style={{ paddingRight: 8, color: at(l.key, 'brake') > 0 ? 'var(--accent-red)' : 'var(--text-tertiary)' }}>
                  {at(l.key, 'brake') > 0 ? 'BRK' : '—'}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    color: l.key === refKey ? 'var(--text-tertiary)' : delta > 0 ? 'var(--accent-red)' : SECTOR_COLOURS.personalBest,
                  }}
                >
                  {l.key === refKey ? 'ref' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(3)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
