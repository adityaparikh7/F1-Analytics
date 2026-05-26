/**
 * F1 Pitwall — Sidebar Component
 *
 * Session navigation and ingestion controls.
 */

import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import { api } from '../lib/api';
import { formatSessionType, formatDate } from '../lib/format';

export const Sidebar: React.FC = () => {
  const { sidebarCollapsed } = useUIStore();
  const {
    sessions,
    sessionsLoading,
    activeSessionKey,
    setActiveSession,
    selectedYear,
    loadSessions,
    forceSyncSeason,
  } = useSessionStore();

  const [ingesting, setIngesting] = useState(false);
  const [ingestEvent, setIngestEvent] = useState('');
  const [ingestType, setIngestType] = useState('R');

  useEffect(() => {
    loadSessions();
  }, []);

  const handleIngest = async () => {
    if (!ingestEvent.trim()) return;
    setIngesting(true);
    try {
      await api.ingestSession(selectedYear, ingestType, undefined, ingestEvent.trim());
      // Reload sessions after a short delay to allow background task to complete
      setTimeout(() => {
        loadSessions();
        setIngesting(false);
      }, 3000);
    } catch (err: any) {
      console.error('Ingest failed:', err);
      alert(`Ingest failed: ${err.message || err}`);
      setIngesting(false);
    }
  };

  const handleIngestCalendar = async () => {
    try {
      await api.ingestCalendar(selectedYear);
    } catch (err) {
      console.error('Calendar ingest failed:', err);
    }
  };

  const handleSyncSeason = async () => {
    setIngesting(true);
    try {
      await forceSyncSeason(selectedYear);
    } finally {
      setIngesting(false);
    }
  };

  if (sidebarCollapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <div style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
          <span style={{ fontSize: 'var(--fs-lg)' }}>🏎</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      {/* Ingest section */}
      <div className="sidebar__section">
        <div className="sidebar__title">Load Session</div>
        <input
          type="text"
          placeholder="Event name..."
          value={ingestEvent}
          onChange={e => setIngestEvent(e.target.value)}
          style={{ width: '100%', marginBottom: 'var(--space-2)' }}
        />
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <select
            value={ingestType}
            onChange={e => setIngestType(e.target.value)}
            style={{ flex: 1 }}
          >
            {['FP1', 'FP2', 'FP3', 'Q', 'SQ', 'S', 'R'].map(t => (
              <option key={t} value={t}>{formatSessionType(t)}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            className="topbar__btn topbar__btn--primary"
            onClick={handleIngest}
            disabled={ingesting}
            style={{ flex: 1, justifyContent: 'center', opacity: ingesting ? 0.6 : 1 }}
          >
            {ingesting ? 'Loading...' : 'Ingest'}
          </button>
          <button
            className="topbar__btn"
            onClick={handleIngestCalendar}
            title="Load calendar"
            style={{ fontSize: 'var(--fs-sm)' }}
          >
            📅
          </button>
          <button
            className="topbar__btn"
            onClick={handleSyncSeason}
            disabled={ingesting}
            title="Sync missing sessions"
            style={{ fontSize: 'var(--fs-sm)', opacity: ingesting ? 0.6 : 1 }}
          >
            🔄
          </button>
        </div>
      </div>

      {/* Sessions list */}
      <div className="sidebar__section" style={{ flex: 1, overflowY: 'auto', borderBottom: 'none' }}>
        <div className="sidebar__title">Sessions</div>
        {sessionsLoading && (
          <div className="state-loading" style={{ minHeight: '60px' }}>Loading...</div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)', padding: 'var(--space-2)' }}>
            No sessions ingested yet.
            <br />Use the form above to load a session.
          </div>
        )}
        {sessions.map(session => (
          <button
            key={session.session_key}
            className={`sidebar__item ${session.session_key === activeSessionKey ? 'sidebar__item--active' : ''}`}
            onClick={() => setActiveSession(session.session_key)}
          >
            <span style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{session.event_name}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {formatSessionType(session.session_type)} · {formatDate(session.date)}
              </div>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
};
