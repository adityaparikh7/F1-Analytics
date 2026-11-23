/**
 * Race Replay — page UI state.
 *
 * One reducer for everything the viewer toggles: the map view and camera, overlays, which side
 * tab is open, and who is selected. Selection is a focused driver plus an optional rival (for
 * head-to-head). The view preferences persist across visits; the selection does not.
 */

import type { GapMode } from './TimingTower';

export type MapView = 'map' | 'follow' | '3d';
export type CameraMode = 'orbit' | 'helicopter' | 'chase' | 'tv';
export type SideTab = 'standings' | 'relative';

export const MAP_VIEWS: MapView[] = ['map', 'follow', '3d'];
export const CAMERA_MODES: CameraMode[] = ['orbit', 'helicopter', 'chase', 'tv'];
/** Follow-cam window: metres of track across the map's shorter side. */
export const ZOOM_LEVELS = [250, 400, 600, 900, 1400];

export interface UiState {
  view: MapView;
  camera: CameraMode;
  headingUp: boolean;
  zoomIndex: number;
  /** 3D elevation exaggeration (1 = true scale). */
  elevation: number;
  labels: boolean;
  battles: boolean;
  director: boolean;
  sideTab: SideTab;
  gapMode: GapMode;
  skipRed: boolean;
  help: boolean;
  focus: string | null;
  rival: string | null;
}

export type UiAction =
  | { type: 'set'; patch: Partial<UiState> }
  | { type: 'select'; abbr: string; shift: boolean }
  | { type: 'follow'; abbr: string; rival?: string | null }
  | { type: 'escape' }
  | { type: 'cycleView' }
  | { type: 'cycleCamera' }
  | { type: 'zoom'; step: 1 | -1 };

const STORAGE_KEY = 'pitwall_replay_view';
const PERSISTED: (keyof UiState)[] = ['view', 'camera', 'headingUp', 'zoomIndex', 'elevation', 'labels', 'battles'];

const DEFAULTS: UiState = {
  view: 'map',
  camera: 'chase',
  headingUp: true,
  zoomIndex: 2,
  elevation: 2,
  labels: true,
  battles: true,
  director: false,
  sideTab: 'standings',
  gapMode: 'interval',
  skipRed: true,
  help: false,
  focus: null,
  rival: null,
};

/** `storageKey` lets another page (lap comparison) remember its own view preferences. */
export function initialUiState(focus: string | null, storageKey = STORAGE_KEY): UiState {
  let saved: Partial<UiState> = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<UiState>;
  } catch {
    saved = {};
  }
  const picked = Object.fromEntries(PERSISTED.filter(k => k in saved).map(k => [k, saved[k]]));
  return { ...DEFAULTS, ...picked, focus };
}

export function persistUiState(state: UiState, storageKey = STORAGE_KEY): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(PERSISTED.map(k => [k, state[k]]))));
  } catch {
    // Private mode or blocked storage: the preferences just don't stick.
  }
}

function next<T>(items: T[], current: T): T {
  return items[(items.indexOf(current) + 1) % items.length];
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };
    case 'select': {
      const { abbr, shift } = action;
      // Picking a driver by hand takes over from the director.
      const base = { ...state, director: false };
      if (shift && state.focus && abbr !== state.focus) {
        return { ...base, rival: state.rival === abbr ? null : abbr };
      }
      if (abbr === state.rival) return { ...base, focus: abbr, rival: null };
      if (abbr === state.focus) return { ...base, focus: null, rival: null };
      return { ...base, focus: abbr };
    }
    case 'follow':
      // Set (not toggle) the focus, e.g. from an event: the user asked to watch this driver.
      return { ...state, director: false, focus: action.abbr, rival: action.rival ?? null };
    case 'escape':
      if (state.help) return { ...state, help: false };
      if (state.rival) return { ...state, rival: null };
      return { ...state, focus: null };
    case 'cycleView':
      return { ...state, view: next(MAP_VIEWS, state.view) };
    case 'cycleCamera':
      return { ...state, camera: next(CAMERA_MODES, state.camera) };
    case 'zoom':
      return {
        ...state,
        zoomIndex: Math.min(Math.max(state.zoomIndex + action.step, 0), ZOOM_LEVELS.length - 1),
      };
  }
}
