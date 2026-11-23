/**
 * Keyboard-shortcut popover shown over the map (the "?" toggle), shared by the race replay and
 * the lap comparison page.
 */

import React from 'react';
import { X } from 'lucide-react';
import { cardTitleStyle, iconButtonStyle } from './styles';

export const ShortcutHelp: React.FC<{ items: [string, string][]; onClose: () => void }> = ({ items, onClose }) => (
  <div
    role="dialog"
    aria-label="Keyboard shortcuts"
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      width: 300,
      background: 'var(--bg-raised)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-lg)',
      padding: 'var(--space-3)',
      zIndex: 2,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
      <span style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>Keyboard shortcuts</span>
      <button style={{ ...iconButtonStyle, width: 24, height: 24 }} onClick={onClose} title="Close (Esc)">
        <X size={12} />
      </button>
    </div>
    {items.map(([keys, what]) => (
      <div key={keys} style={{ display: 'flex', gap: 'var(--space-2)', fontSize: 'var(--fs-xs)', padding: '2px 0' }}>
        <span className="mono" style={{ width: 120, flexShrink: 0, color: 'var(--text-primary)' }}>
          {keys}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>{what}</span>
      </div>
    ))}
  </div>
);
