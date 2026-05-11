/**
 * F1 Pitwall — Session Store
 *
 * Manages the active session context that drives all panels.
 */

import { create } from 'zustand';
import type { SessionMeta } from '../lib/api';
import { api } from '../lib/api';

interface SessionState {
  // Active session
  activeSessionKey: string | null;
  activeSession: SessionMeta | null;

  // Available sessions
  sessions: SessionMeta[];
  sessionsLoading: boolean;

  // Selected year for filtering
  selectedYear: number;

  // Actions
  setActiveSession: (key: string) => Promise<void>;
  clearActiveSession: () => void;
  loadSessions: (year?: number) => Promise<void>;
  setSelectedYear: (year: number) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  activeSessionKey: null,
  activeSession: null,
  sessions: [],
  sessionsLoading: false,
  selectedYear: new Date().getFullYear(),

  setActiveSession: async (key: string) => {
    try {
      const session = await api.getSession(key);
      set({ activeSessionKey: key, activeSession: session });
      // Persist to localStorage
      localStorage.setItem('pitwall_active_session', key);
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  },

  clearActiveSession: () => {
    set({ activeSessionKey: null, activeSession: null });
    localStorage.removeItem('pitwall_active_session');
  },

  loadSessions: async (year?: number) => {
    set({ sessionsLoading: true });
    try {
      const targetYear = year ?? get().selectedYear;
      const sessions = await api.listSessions(targetYear);
      set({ sessions, sessionsLoading: false });
    } catch (err) {
      console.error('Failed to load sessions:', err);
      set({ sessionsLoading: false });
    }
  },

  setSelectedYear: (year: number) => {
    set({ selectedYear: year });
    get().loadSessions(year);
  },
}));
