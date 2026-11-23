/**
 * Race Replay — toolbar above the map: which view, that view's own controls, and the overlays.
 */

import React from 'react';
import { Box, Compass, Crosshair, Keyboard, Map as MapIcon, Minus, Plus, Swords, Tag, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { iconButtonStyle, selectStyle, toggleStyle } from './styles';
import type { CameraMode, MapView, UiAction, UiState } from './uiState';
import { ZOOM_LEVELS } from './uiState';

const VIEWS: { id: MapView; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'map', label: 'Map', icon: MapIcon, hint: 'Whole track' },
  { id: 'follow', label: 'Follow', icon: Crosshair, hint: 'Camera follows the selected car (the leader if none)' },
  { id: '3d', label: '3D', icon: Box, hint: '3D track with elevation' },
];

const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'helicopter', label: 'Helicopter' },
  { id: 'chase', label: 'Chase' },
  { id: 'tv', label: 'TV' },
];

function Toggle({
  active,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label?: string;
  title: string;
}) {
  return (
    <button style={{ ...toggleStyle(active), height: 28 }} onClick={onClick} title={title} aria-pressed={active}>
      <Icon size={14} />
      {label}
    </button>
  );
}

export const MapToolbar: React.FC<{
  state: UiState;
  dispatch: React.Dispatch<UiAction>;
  /** Set when the replay has elevation; otherwise 3D is drawn flat. */
  hasElevation: boolean;
  /** Race-only toggles; the lap comparison page leaves them out. */
  showDirector?: boolean;
  showBattles?: boolean;
  /** Page-specific toggles, shown before the label toggle. */
  extra?: React.ReactNode;
}> = ({ state, dispatch, hasElevation, showDirector = true, showBattles = true, extra }) => {
  const set = (patch: Partial<UiState>) => dispatch({ type: 'set', patch });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 2 }} role="group" aria-label="Map view">
        {VIEWS.map(v => (
          <Toggle
            key={v.id}
            active={state.view === v.id}
            onClick={() => set({ view: v.id })}
            icon={v.icon}
            label={v.label}
            title={`${v.hint} (V)`}
          />
        ))}
      </div>

      {state.view === 'follow' && (
        <>
          <Toggle
            active={state.headingUp}
            onClick={() => set({ headingUp: !state.headingUp })}
            icon={Compass}
            label="Heading up"
            title="Rotate the map so the track ahead points up (H)"
          />
          <button style={iconButtonStyle} onClick={() => dispatch({ type: 'zoom', step: 1 })} title="Zoom out (−)">
            <Minus size={14} />
          </button>
          <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', minWidth: 46, textAlign: 'center' }}>
            {ZOOM_LEVELS[state.zoomIndex]} m
          </span>
          <button style={iconButtonStyle} onClick={() => dispatch({ type: 'zoom', step: -1 })} title="Zoom in (=)">
            <Plus size={14} />
          </button>
        </>
      )}

      {state.view === '3d' && (
        <>
          <select
            style={selectStyle}
            value={state.camera}
            onChange={e => set({ camera: e.target.value as CameraMode })}
            title="Camera (C)"
          >
            {CAMERAS.map(c => (
              <option key={c.id} value={c.id}>
                {c.label} camera
              </option>
            ))}
          </select>
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}
            title={hasElevation ? 'Exaggerate elevation changes' : 'This replay has no elevation data yet'}
          >
            Elevation
            <input
              type="range"
              min={1}
              max={5}
              step={0.5}
              value={state.elevation}
              disabled={!hasElevation}
              onChange={e => set({ elevation: Number(e.target.value) })}
              style={{ width: 80 }}
            />
            <span className="mono" style={{ minWidth: 26 }}>
              {hasElevation ? `${state.elevation}×` : 'flat'}
            </span>
          </label>
        </>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
        {showDirector && (
          <Toggle
            active={state.director}
            onClick={() => set({ director: !state.director })}
            icon={Video}
            label="Director"
            title="Let the director pick who to follow: battles, pit stops, incidents (D)"
          />
        )}
        {extra}
        <Toggle active={state.labels} onClick={() => set({ labels: !state.labels })} icon={Tag} title="Driver labels (L)" />
        {showBattles && (
          <Toggle
            active={state.battles}
            onClick={() => set({ battles: !state.battles })}
            icon={Swords}
            title="Highlight cars within 1 s of the car ahead (B)"
          />
        )}
        <Toggle active={state.help} onClick={() => set({ help: !state.help })} icon={Keyboard} title="Keyboard shortcuts (?)" />
      </div>
    </div>
  );
};
