/**
 * F1 Pitwall — Layout Store
 *
 * Manages the grid layout, panel instances, and named layouts.
 */

import { create } from 'zustand';
import type { Layout } from 'react-grid-layout';

export interface PanelInstance {
  instanceId: string;    // {panelTypeId}_{uuid}
  panelTypeId: string;   // from panel catalogue
  config: Record<string, unknown>;
}

interface NamedLayout {
  name: string;
  layout: Layout[];
  panels: PanelInstance[];
}

interface LayoutState {
  // Current state
  currentLayout: Layout[];
  activePanels: PanelInstance[];
  currentLayoutName: string;

  // Saved layouts
  savedLayouts: NamedLayout[];

  // Actions
  setLayout: (layout: Layout[]) => void;
  addPanel: (panelTypeId: string, defaultSize: { w: number; h: number }) => void;
  removePanel: (instanceId: string) => void;
  updatePanelConfig: (instanceId: string, config: Record<string, unknown>) => void;
  saveLayout: (name: string) => void;
  loadLayout: (name: string) => void;
  deleteLayout: (name: string) => void;
  restoreFromStorage: () => void;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function findNextPosition(layout: Layout[], cols: number = 12): { x: number; y: number } {
  if (layout.length === 0) return { x: 0, y: 0 };
  const maxY = Math.max(...layout.map(l => l.y + l.h));
  return { x: 0, y: maxY };
}

function persistToStorage(state: { currentLayout: Layout[]; activePanels: PanelInstance[]; currentLayoutName: string; savedLayouts: NamedLayout[] }) {
  localStorage.setItem('pitwall_layout', JSON.stringify({
    currentLayout: state.currentLayout,
    activePanels: state.activePanels,
    currentLayoutName: state.currentLayoutName,
    savedLayouts: state.savedLayouts,
  }));
}

// Default layout for fresh installs
const DEFAULT_PANELS: PanelInstance[] = [
  { instanceId: 'session-results_default', panelTypeId: 'session-results', config: {} },
  { instanceId: 'lap-distribution_default', panelTypeId: 'lap-distribution', config: {} },
  { instanceId: 'strategy-board_default', panelTypeId: 'strategy-board', config: {} },
];

const DEFAULT_LAYOUT: Layout[] = [
  { i: 'session-results_default', x: 0, y: 0, w: 12, h: 5, minW: 6, minH: 3 },
  { i: 'lap-distribution_default', x: 0, y: 5, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'strategy-board_default', x: 6, y: 5, w: 6, h: 5, minW: 6, minH: 3 },
];

export const useLayoutStore = create<LayoutState>((set, get) => ({
  currentLayout: DEFAULT_LAYOUT,
  activePanels: DEFAULT_PANELS,
  currentLayoutName: 'Default',
  savedLayouts: [],

  setLayout: (layout: Layout[]) => {
    set({ currentLayout: layout });
    persistToStorage(get());
  },

  addPanel: (panelTypeId: string, defaultSize: { w: number; h: number }) => {
    const instanceId = `${panelTypeId}_${generateId()}`;
    const { x, y } = findNextPosition(get().currentLayout);

    const newLayoutItem: Layout = {
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
    persistToStorage(get());
  },

  removePanel: (instanceId: string) => {
    set(state => ({
      currentLayout: state.currentLayout.filter(l => l.i !== instanceId),
      activePanels: state.activePanels.filter(p => p.instanceId !== instanceId),
    }));
    persistToStorage(get());
  },

  updatePanelConfig: (instanceId: string, config: Record<string, unknown>) => {
    set(state => ({
      activePanels: state.activePanels.map(p =>
        p.instanceId === instanceId ? { ...p, config: { ...p.config, ...config } } : p
      ),
    }));
    persistToStorage(get());
  },

  saveLayout: (name: string) => {
    const { currentLayout, activePanels, savedLayouts } = get();
    const existing = savedLayouts.findIndex(l => l.name === name);
    const newLayout: NamedLayout = { name, layout: currentLayout, panels: activePanels };

    const updated = existing >= 0
      ? savedLayouts.map((l, i) => i === existing ? newLayout : l)
      : [...savedLayouts, newLayout];

    set({ savedLayouts: updated, currentLayoutName: name });
    persistToStorage(get());
  },

  loadLayout: (name: string) => {
    const layout = get().savedLayouts.find(l => l.name === name);
    if (layout) {
      set({
        currentLayout: layout.layout,
        activePanels: layout.panels,
        currentLayoutName: name,
      });
      persistToStorage(get());
    }
  },

  deleteLayout: (name: string) => {
    set(state => ({
      savedLayouts: state.savedLayouts.filter(l => l.name !== name),
    }));
    persistToStorage(get());
  },

  restoreFromStorage: () => {
    try {
      const stored = localStorage.getItem('pitwall_layout');
      if (stored) {
        const parsed = JSON.parse(stored);
        set({
          currentLayout: parsed.currentLayout || DEFAULT_LAYOUT,
          activePanels: parsed.activePanels || DEFAULT_PANELS,
          currentLayoutName: parsed.currentLayoutName || 'Default',
          savedLayouts: parsed.savedLayouts || [],
        });
      }
    } catch {
      // Use defaults on parse error
    }
  },
}));
