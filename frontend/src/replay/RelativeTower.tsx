/**
 * Race Replay — relative timing: the cars physically around the followed driver on track,
 * whatever lap they are on (see `relative.ts`).
 */

import React, { useMemo } from 'react';
import { getCompoundColour } from '../lib/colours';
import { formatCompound } from '../lib/format';
import type { Replay } from './decode';
import { relativeAt } from './relative';
import type { StandingRow } from './replayMath';

interface Props {
  replay: Replay;
  rows: StandingRow[];
  time: number;
  focus: string | null;
  rival: string | null;
  onSelect: (abbr: string, shift: boolean) => void;
  rowHeight?: number;
}

function formatRelative(gap: number | null, delta: number): string {
  if (gap == null) return `${delta >= 0 ? '+' : '−'}${Math.round(Math.abs(delta))} m`;
  if (gap === 0) return '';
  return `${gap < 0 ? '−' : '+'}${Math.abs(gap).toFixed(Math.abs(gap) < 100 ? 3 : 1)}`;
}

export const RelativeTower: React.FC<Props> = ({ replay, rows, time, focus, rival, onSelect, rowHeight = 26 }) => {
  const rel = useMemo(() => (focus ? relativeAt(replay, rows, focus, time) : []), [replay, rows, focus, time]);

  if (!focus) {
    return (
      <div style={{ padding: 'var(--space-3)', color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>
        Follow a driver to see the cars around them on track — including ones a lap up or down — and the
        gaps to each.
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          padding: '0 var(--space-2) var(--space-1)',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-tertiary)',
        }}
      >
        <span style={{ width: 18, textAlign: 'right' }}>P</span>
        <span style={{ flex: 1, paddingLeft: 11 }}>On track, nearest first</span>
        <span>gap</span>
      </div>
      {rel.map(({ row, delta, lapDiff, gap }) => {
        const drv = row.driver;
        const isFocus = drv.abbr === focus;
        return (
          <div
            key={drv.abbr}
            onClick={e => onSelect(drv.abbr, e.shiftKey)}
            style={{
              height: rowHeight,
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: '0 var(--space-2)',
              borderBottom: '1px solid var(--border-default)',
              background: isFocus ? 'var(--bg-active)' : drv.abbr === rival ? 'var(--bg-hover)' : 'transparent',
              cursor: 'pointer',
              fontSize: 'var(--fs-sm)',
            }}
          >
            <span className="mono" style={{ width: 18, textAlign: 'right', color: 'var(--text-secondary)' }}>
              {row.position}
            </span>
            <span style={{ width: 3, height: rowHeight - 10, borderRadius: 1, background: drv.colour, flexShrink: 0 }} />
            <span style={{ width: 34, fontWeight: 700 }}>{drv.abbr}</span>
            <span style={{ width: 34 }}>
              {lapDiff !== 0 && (
                <span
                  className="mono"
                  title={lapDiff > 0 ? `${lapDiff} lap${lapDiff > 1 ? 's' : ''} ahead` : `${-lapDiff} lap${lapDiff < -1 ? 's' : ''} behind`}
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: '0 4px',
                    borderRadius: 'var(--radius-sm)',
                    color: lapDiff > 0 ? 'var(--accent-amber)' : 'var(--accent-blue)',
                    border: `1px solid ${lapDiff > 0 ? 'var(--accent-amber)' : 'var(--accent-blue)'}`,
                  }}
                >
                  {lapDiff > 0 ? '+' : '−'}
                  {Math.abs(lapDiff)}L
                </span>
              )}
              {row.state === 'pit' && (
                <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent-teal)', marginLeft: 2 }}>
                  PIT
                </span>
              )}
            </span>
            <span style={{ width: 30, display: 'flex', alignItems: 'center', gap: 3 }} title={row.compound ?? ''}>
              {row.compound && (
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: '50%',
                    border: `2px solid ${getCompoundColour(row.compound)}`,
                    fontSize: 7,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {formatCompound(row.compound)}
                </span>
              )}
              <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
                {row.tyreAge ?? ''}
              </span>
            </span>
            <span
              className="mono"
              style={{
                flex: 1,
                textAlign: 'right',
                fontSize: 'var(--fs-xs)',
                color: isFocus ? 'var(--text-tertiary)' : gap != null && Math.abs(gap) < 1 ? 'var(--accent-amber)' : 'var(--text-primary)',
              }}
            >
              {isFocus ? 'following' : formatRelative(gap, delta)}
            </span>
          </div>
        );
      })}
    </div>
  );
};
