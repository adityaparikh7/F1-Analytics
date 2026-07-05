/**
 * F1 Pitwall — Layout Store
 *
 * Manages the grid layout, panel instances, and named layouts.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Layout, LayoutItem } from 'react-grid-layout';

export interface PanelInstance {
  instanceId: string;    // {panelTypeId}_{uuid}
  panelTypeId: string;   // from panel catalogue
  config: Record<string, unknown>;
}

interface NamedLayout {
  name: string;
  layout: Layout;
  panels: PanelInstance[];
}

interface LayoutState {
  // Current state
  currentLayout: Layout;
  activePanels: PanelInstance[];
  currentLayoutName: string;

  // Saved layouts
  savedLayouts: NamedLayout[];

  // Actions
  setLayout: (layout: Layout) => void;
  addPanel: (panelTypeId: string, defaultSize: { w: number; h: number }) => void;
  removePanel: (instanceId: string) => void;
  updatePanelConfig: (instanceId: string, config: Record<string, unknown>) => void;
  saveLayout: (name: string) => void;
  loadLayout: (name: string) => void;
  deleteLayout: (name: string) => void;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function findNextPosition(layout: Layout): { x: number; y: number } {
  if (layout.length === 0) return { x: 0, y: 0 };
  const maxY = Math.max(...layout.map(l => l.y + l.h));
  return { x: 0, y: maxY };
}

// Default layout for fresh installs
const DEFAULT_PANELS: PanelInstance[] = [
  { instanceId: 'season-calendar_default', panelTypeId: 'season-calendar', config: {} },
  { instanceId: 'session-results_default', panelTypeId: 'session-results', config: {} },
  { instanceId: 'track-map_default', panelTypeId: 'track-map', config: {} },
  { instanceId: 'lap-distribution_default', panelTypeId: 'lap-distribution', config: {} },
  { instanceId: 'strategy-board_default', panelTypeId: 'strategy-board', config: {} },
  { instanceId: 'driver-standings_default', panelTypeId: 'driver-standings', config: {} },
  { instanceId: 'constructor-standings_default', panelTypeId: 'constructor-standings', config: {} },
];

const DEFAULT_LAYOUT: Layout = [
  { i: 'season-calendar_default', x: 0, y: 0, w: 6, h: 3, minW: 6, minH: 1 },
  { i: 'session-results_default', x: 0, y: 0, w: 6, h: 4, minW: 6, minH: 3 },
  { i: 'driver-standings_default', x: 6, y: 0, w: 3, h: 3, minW: 3, minH: 2 },
  { i: 'constructor-standings_default', x: 12, y: 0, w: 3, h: 3, minW: 3, minH: 2 },
  { i: 'track-map_default', x: 0, y: 0, w: 6, h: 4, minW: 4, minH: 3 },
  { i: 'lap-distribution_default', x: 6, y: 6, w: 6, h: 4, minW: 4, minH: 3 },
  { i: 'strategy-board_default', x: 6, y: 5, w: 6, h: 4, minW: 6, minH: 3 },
];

// Migrate old manual persistence format to zustand/persist format
if (typeof window !== 'undefined') {
  try {
    const oldStorage = localStorage.getItem('pitwall_layout');
    if (oldStorage && !oldStorage.includes('"state":')) {
      const parsed = JSON.parse(oldStorage);
      localStorage.setItem('pitwall_layout', JSON.stringify({ state: parsed, version: 0 }));
    }
  } catch (e) {
    // Ignore migration errors
  }
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      currentLayout: DEFAULT_LAYOUT,
      activePanels: DEFAULT_PANELS,
      currentLayoutName: 'Default',
      savedLayouts: [],

      setLayout: (layout: Layout) => {
        set({ currentLayout: layout });
      },

      addPanel: (panelTypeId: string, defaultSize: { w: number; h: number }) => {
        const instanceId = `${panelTypeId}_${generateId()}`;
        const { x, y } = findNextPosition(get().currentLayout);

        const newLayoutItem: LayoutItem = {
          i: instanceId,
          x, y,
          w: defaultSize.w,
          h: defaultSize.h,
        };

        const newPanel: PanelInstance = {
          instanceId,
          panelTypeId,
          config: {},
        };

        set(state => ({
          currentLayout: [...state.currentLayout, newLayoutItem],
          activePanels: [...state.activePanels, newPanel],
        }));
      },

      removePanel: (instanceId: string) => {
        set(state => ({
          currentLayout: state.currentLayout.filter(l => l.i !== instanceId),
          activePanels: state.activePanels.filter(p => p.instanceId !== instanceId),
        }));
      },

      updatePanelConfig: (instanceId: string, config: Record<string, unknown>) => {
        set(state => ({
          activePanels: state.activePanels.map(p =>
            p.instanceId === instanceId ? { ...p, config: { ...p.config, ...config } } : p
          ),
        }));
      },

      saveLayout: (name: string) => {
        const { currentLayout, activePanels, savedLayouts } = get();
        const existing = savedLayouts.findIndex(l => l.name === name);
        const newLayout: NamedLayout = { name, layout: currentLayout, panels: activePanels };

        const updated = existing >= 0
          ? savedLayouts.map((l, i) => i === existing ? newLayout : l)
          : [...savedLayouts, newLayout];

        set({ savedLayouts: updated, currentLayoutName: name });
      },

      loadLayout: (name: string) => {
        const layout = get().savedLayouts.find(l => l.name === name);
        if (layout) {
          set({
            currentLayout: layout.layout,
            activePanels: layout.panels,
            currentLayoutName: name,
          });
        }
      },

      deleteLayout: (name: string) => {
        set(state => ({
          savedLayouts: state.savedLayouts.filter(l => l.name !== name),
        }));
      },
    }),
    {
      name: 'pitwall_layout',
    }
  )
);
