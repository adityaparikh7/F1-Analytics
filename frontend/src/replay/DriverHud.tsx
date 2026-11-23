/**
 * Race Replay — focused-driver HUD.
 *
 * Live speed, gear, RPM, throttle, brake and DRS for one car (see `HudReadouts`), plus its place
 * in the race and the gaps either side, which update at the tower's rate.
 */

import React from 'react';
import { X } from 'lucide-react';
import { getCompoundColour } from '../lib/colours';
import type { Replay } from './decode';
import { HudReadouts } from './HudReadouts';
import type { StandingRow } from './replayMath';
import { formatReplayGap } from './replayMath';
import { hudLabelStyle as labelStyle, iconButtonStyle } from './styles';
import { useDriverHud } from './useDriverHud';

interface Props {
  sessionKey: string;
  replay: Replay;
  subscribe: (cb: (t: number) => void) => () => void;
  abbr: string;
  rows: StandingRow[];
  onClose: () => void;
}

export const DriverHud: React.FC<Props> = ({ sessionKey, replay, subscribe, abbr, rows, onClose }) => {
  const { hud, error } = useDriverHud(sessionKey, abbr, replay.version);

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

      {error ? (
        <div className="state-error" style={{ padding: 'var(--space-2)' }}>
          Telemetry unavailable: {error}
        </div>
      ) : !hud ? (
        <div className="state-loading" style={{ padding: 0 }}>
          <div className="skeleton skeleton--bar" />
          <div className="skeleton skeleton--bar" />
        </div>
      ) : (
        <HudReadouts replay={replay} hud={hud} subscribe={subscribe} />
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
