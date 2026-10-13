/**
 * Race Replay — timing tower.
 *
 * Rows are absolutely positioned and slide to their new slot on a CSS transition, so an
 * overtake reads as one car moving past another rather than the list redrawing.
 */

import React from 'react';
import { Flag } from 'lucide-react';
import { getCompoundColour } from '../lib/colours';
import { formatCompound } from '../lib/format';
import type { StandingRow } from './replayMath';
import { formatReplayGap } from './replayMath';

export type GapMode = 'interval' | 'leader';

interface Props {
  rows: StandingRow[];
  mode: GapMode;
  focus: string | null;
  battles?: Set<string>;
  onSelect?: (abbr: string) => void;
  rowHeight?: number;
}

function StateChip({ row }: { row: StandingRow }) {
  if (row.state === 'pit') {
    return (
      <span
        className="mono"
        style={{
          fontSize: 9,
          fontWeight: 700,
          padding: '0 4px',
          borderRadius: 'var(--radius-sm)',
          background: 'color-mix(in srgb, var(--accent-teal) 18%, transparent)',
          color: 'var(--accent-teal)',
        }}
      >
        PIT
      </span>
    );
  }
  if (row.state === 'finished') return <Flag size={11} color="var(--text-primary)" aria-label="Finished" />;
  return null;
}

export const TimingTower: React.FC<Props> = ({
  rows,
  mode,
  focus,
  battles,
  onSelect,
  rowHeight = 26,
}) => {
  return (
    <div style={{ position: 'relative', height: rows.length * rowHeight }}>
      {rows.map((row, i) => {
        const drv = row.driver;
        const isFocus = drv.abbr === focus;
        const inBattle = battles?.has(drv.abbr) ?? false;
        const out = row.state === 'out';
        const gap = mode === 'interval' ? row.interval : row.gapToLeader;
        const gapText =
          row.state === 'grid'
            ? drv.grid
              ? `Grid ${drv.grid}`
              : 'Pit lane'
            : out
              ? 'OUT'
              : formatReplayGap(gap, mode === 'interval' ? 'Interval' : 'Leader');

        return (
          <div
            key={drv.abbr}
            onClick={onSelect ? () => onSelect(drv.abbr) : undefined}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: rowHeight,
              transform: `translateY(${i * rowHeight}px)`,
              transition: 'transform 450ms ease',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: '0 var(--space-2)',
              borderBottom: '1px solid var(--border-default)',
              background: isFocus ? 'var(--bg-active)' : 'transparent',
              cursor: onSelect ? 'pointer' : 'default',
              opacity: out ? 0.45 : 1,
              fontSize: 'var(--fs-sm)',
            }}
          >
            <span className="mono" style={{ width: 18, textAlign: 'right', color: 'var(--text-secondary)' }}>
              {row.position}
            </span>
            <span style={{ width: 3, height: rowHeight - 10, borderRadius: 1, background: drv.colour, flexShrink: 0 }} />
            <span style={{ width: 34, fontWeight: 700, letterSpacing: '0.02em' }}>{drv.abbr}</span>
            <span
              className="mono"
              style={{
                width: 22,
                fontSize: 'var(--fs-xs)',
                color:
                  row.gridDelta && row.gridDelta > 0
                    ? 'var(--accent-teal)'
                    : row.gridDelta && row.gridDelta < 0
                      ? 'var(--accent-red)'
                      : 'var(--text-tertiary)',
              }}
              title="Places gained or lost since the start"
            >
              {row.gridDelta ? `${row.gridDelta > 0 ? '▲' : '▼'}${Math.abs(row.gridDelta)}` : ''}
            </span>
            <span
              className="mono"
              style={{
                flex: 1,
                textAlign: 'right',
                whiteSpace: 'nowrap',
                color: inBattle && mode === 'interval' && i > 0 ? 'var(--accent-amber)' : 'var(--text-primary)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              {gapText}
            </span>
            <span style={{ width: 22, display: 'flex', justifyContent: 'center' }}>
              <StateChip row={row} />
            </span>
            <span style={{ width: 40, display: 'flex', alignItems: 'center', gap: 4 }} title={row.compound ?? ''}>
              {row.compound && (
                <span
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: '50%',
                    border: `2px solid ${getCompoundColour(row.compound)}`,
                    fontSize: 8,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {formatCompound(row.compound)}
                </span>
              )}
              <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
                {row.tyreAge ?? ''}
              </span>
            </span>
            <span
              className="mono"
              style={{ width: 14, textAlign: 'right', fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}
              title="Pit stops"
            >
              {row.stops || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
};
