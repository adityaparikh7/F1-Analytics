/**
 * F1 Pitwall — UI Store
 *
 * Transient UI state: sidebar, drawer, theme.
 */

import { create } from 'zustand';

interface UIState {
  sidebarCollapsed: boolean;
  catalogueOpen: boolean;

  toggleSidebar: () => void;
  openCatalogue: () => void;
  closeCatalogue: () => void;
  toggleCatalogue: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  catalogueOpen: false,

  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openCatalogue: () => set({ catalogueOpen: true }),
  closeCatalogue: () => set({ catalogueOpen: false }),
  toggleCatalogue: () => set(s => ({ catalogueOpen: !s.catalogueOpen })),
}));
