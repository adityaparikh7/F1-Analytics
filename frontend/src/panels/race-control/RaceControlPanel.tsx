/**
 * F1 Pitwall — Race Control Panel
 *
 * Displays race control messages for the selected session.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { RaceControlMessage } from '../../lib/api';
import { api } from '../../lib/api';
import { Flag, AlertCircle, Info } from 'lucide-react';

// ── Helpers ────────────────────────────────────────────────────────────

function getCategoryIcon(category: string | null) {
  if (category === 'Flag') return <Flag size={14} className="text-secondary" />;
  if (category === 'Incident' || category === 'Other') return <AlertCircle size={14} className="text-amber" />;
  return <Info size={14} className="text-secondary" />;
}

function getFlagClass(flag: string | null) {
  if (!flag) return '';
  const f = flag.toUpperCase();
  if (f.includes('GREEN')) return 'text-teal';
  if (f.includes('RED')) return 'text-red';
  if (f.includes('YELLOW') || f.includes('VSC') || f.includes('SAFETY CAR')) return 'text-amber';
  if (f.includes('BLACK AND WHITE')) return 'text-secondary';
  return 'text-primary';
}

function formatTime(timeStr: string | null) {
  if (!timeStr) return '—';
  try {
    const d = new Date(timeStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return timeStr;
  }
}

// ── Main Panel ─────────────────────────────────────────────────────────

const RaceControlPanel: React.FC<PanelProps> = ({ sessionKey }) => {
  const [messages, setMessages] = useState<RaceControlMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    setLoading(true);
    setError(null);
    api.getRaceControlMessages(sessionKey)
      .then(data => { setMessages(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [sessionKey]);

  if (!sessionKey) {
    return <div className="state-empty">Select a session to view race control messages</div>;
  }

  if (loading) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-error">
        <p>Failed to load race control messages.</p>
        <span className="text-xs text-secondary">{error}</span>
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return <div className="state-empty">No messages found for this session</div>;
  }

  return (
    <div style={{ margin: 'calc(var(--space-3) * 0)', overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '80px' }}>Time</th>
            <th style={{ width: '40px' }}>Lap</th>
            <th style={{ width: '20px' }}></th>
            <th>Message</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m, idx) => (
            <tr key={idx}>
              <td className="text-secondary tabular-nums text-xs">
                {formatTime(m.Time)}
              </td>
              <td className="tabular-nums text-xs">
                {m.Lap || '—'}
              </td>
              <td>
                <span title={m.Category || ''}>{getCategoryIcon(m.Category)}</span>
              </td>
              <td className="text-sm" style={{ whiteSpace: 'normal', minWidth: '200px' }}>
                {m.Message}
                {m.Sector && <span className="text-secondary text-xs ml-2">(Sector {m.Sector})</span>}
                {m.RacingNumber && <span className="text-amber text-xs ml-2">(Car {m.RacingNumber})</span>}
              </td>
              <td className={`text-xs font-semibold ${getFlagClass(m.Flag)}`}>
                {m.Flag || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── Registration ───────────────────────────────────────────────────────

registerPanel({
  id: 'race-control',
  title: 'Race Control',
  category: 'session',
  Component: RaceControlPanel,
});

export default RaceControlPanel;
