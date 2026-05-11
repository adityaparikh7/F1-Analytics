/**
 * F1 Pitwall — Topbar Component
 */

import React from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import { useLayoutStore } from '../store/layoutStore';
import { formatSessionType } from '../lib/format';

export const Topbar: React.FC = () => {
  const { activeSession, selectedYear, setSelectedYear } = useSessionStore();
  const { openCatalogue, toggleSidebar } = useUIStore();
  const { currentLayoutName, saveLayout, savedLayouts, loadLayout } = useLayoutStore();

  return (
    <header className="topbar">
      {/* Logo */}
      <div className="topbar__logo" onClick={toggleSidebar} style={{ cursor: 'pointer' }}>
        <div className="topbar__logo-icon" />
        <span>PITWALL</span>
      </div>

      {/* Session breadcrumb */}
      <div className="topbar__session-selector">
        <div className="topbar__breadcrumb">
          <select
            value={selectedYear}
            onChange={e => setSelectedYear(Number(e.target.value))}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: 'var(--fs-base)', cursor: 'pointer' }}
          >
            {Array.from({ length: 9 }, (_, i) => 2026 - i).map(y => (
              <option key={y} value={y} style={{ background: 'var(--bg-panel)' }}>{y}</option>
            ))}
          </select>
          {activeSession && (
            <>
              <span className="topbar__breadcrumb-sep">›</span>
              <span className="topbar__breadcrumb-item">{activeSession.event_name}</span>
              <span className="topbar__breadcrumb-sep">›</span>
              <span className="topbar__breadcrumb-item">
                {formatSessionType(activeSession.session_type)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="topbar__actions">
        {/* Layout name */}
        <span className="text-secondary mono" style={{ fontSize: 'var(--fs-sm)' }}>
          {currentLayoutName}
        </span>

        {/* Saved layouts dropdown */}
        {savedLayouts.length > 0 && (
          <select
            onChange={e => loadLayout(e.target.value)}
            value=""
            style={{
              background: 'transparent', border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
              fontSize: 'var(--fs-sm)', padding: '2px 8px', cursor: 'pointer',
            }}
          >
            <option value="" disabled>Layouts</option>
            {savedLayouts.map(l => (
              <option key={l.name} value={l.name} style={{ background: 'var(--bg-panel)' }}>
                {l.name}
              </option>
            ))}
          </select>
        )}

        {/* Save layout */}
        <button
          className="topbar__btn"
          onClick={() => {
            const name = prompt('Layout name:', currentLayoutName);
            if (name) saveLayout(name);
          }}
        >
          💾 Save
        </button>

        {/* Add panel */}
        <button className="topbar__btn topbar__btn--primary" onClick={openCatalogue}>
          + Panel
        </button>
      </div>
    </header>
  );
};
