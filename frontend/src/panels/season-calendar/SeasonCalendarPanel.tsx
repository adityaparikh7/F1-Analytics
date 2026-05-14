/**
 * F1 Pitwall — Season Calendar Panel
 *
 * Full season schedule with round numbers, dates, and circuit info.
 */

import React, { useEffect, useState } from 'react';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import type { CalendarEvent } from '../../lib/api';
import { api } from '../../lib/api';
import { useSessionStore } from '../../store/sessionStore';
import { formatDate } from '../../lib/format';

const SeasonCalendarPanel: React.FC<PanelProps> = () => {
  const selectedYear = useSessionStore(s => s.selectedYear);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getCalendar(selectedYear)
      .then(data => { setEvents(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [selectedYear]);

  if (loading) {
    return (
      <div className="state-loading">
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
        <div className="skeleton skeleton--bar" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-error">
        {error}
        <button className="state-error__retry" onClick={() => setError(null)}>Retry</button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="state-empty">
        No calendar data for {selectedYear}.
        <br />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
          Use the 📅 button in the sidebar to ingest the calendar.
        </span>
      </div>
    );
  }

  const now = new Date();

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Rd</th>
            <th>Event</th>
            <th>Circuit</th>
            <th>Country</th>
            <th>Date</th>
            <th>Format</th>
          </tr>
        </thead>
        <tbody>
          {events.map(ev => {
            const eventDate = ev.event_date ? new Date(ev.event_date) : null;
            const isPast = eventDate && eventDate < now;
            const isNext = eventDate && !isPast &&
              events.filter(e => e.event_date && new Date(e.event_date) < now).length ===
              events.indexOf(ev) - (events.findIndex(e => e.event_date && new Date(e.event_date) >= now) > 0 ? events.findIndex(e => e.event_date && new Date(e.event_date) >= now) : 0)
              ? false : false;

            return (
              <tr key={ev.round_number} style={{ opacity: isPast ? 0.5 : 1 }}>
                <td>
                  <span className="data-table__position" style={{
                    background: isPast ? 'transparent' : 'var(--accent-red)',
                    color: isPast ? 'var(--text-tertiary)' : '#fff',
                    borderRadius: '3px',
                    padding: '1px 6px',
                    fontSize: 'var(--fs-xs)',
                  }}>
                    {ev.round_number}
                  </span>
                </td>
                <td style={{ fontWeight: isPast ? 400 : 600 }}>{ev.event_name}</td>
                <td className="text-secondary">{ev.circuit_name}</td>
                <td className="text-secondary">{ev.country}</td>
                <td>{formatDate(ev.event_date)}</td>
                <td>
                  {ev.event_format !== 'conventional' && (
                    <span className="badge" style={{
                      background: 'var(--accent-amber)',
                      color: 'var(--text-inverted)',
                      fontSize: 'var(--fs-xs)',
                    }}>
                      Sprint
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

registerPanel({
  id: 'season-calendar',
  title: 'Season Calendar',
  category: 'session',
  Component: SeasonCalendarPanel,
});

export default SeasonCalendarPanel;
