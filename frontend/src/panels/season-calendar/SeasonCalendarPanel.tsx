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
import { getDriverColour } from '../../lib/colours';

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

  // Find the first event in the future (next upcoming event)
  const nextEvent = events.find(ev => {
    const eventDate = ev.event_date ? new Date(ev.event_date) : null;
    return eventDate && eventDate >= now;
  });
  const nextRoundNumber = nextEvent ? nextEvent.round_number : null;

  return (
    <div style={{ overflowX: 'auto' }}>
      <style>{`
        @keyframes next-pulse-glow {
          0% { box-shadow: 0 0 0 0 rgba(0, 210, 190, 0.4); }
          70% { box-shadow: 0 0 0 5px rgba(0, 210, 190, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 210, 190, 0); }
        }
      `}</style>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ paddingLeft: '12px' }}>Rd</th>
            <th>Event</th>
            <th>Circuit</th>
            {/* <th>Country</th> */}
            <th>Date</th>
            <th>Format</th>
            <th>Winner</th>
            <th>Sprint Winner</th>
          </tr>
        </thead>
        <tbody>
          {events.map(ev => {
            const eventDate = ev.event_date ? new Date(ev.event_date) : null;
            const isPast = eventDate && eventDate < now;
            const isNext = ev.round_number === nextRoundNumber;

            return (
              <tr 
                key={ev.round_number} 
                style={{ 
                  background: isNext 
                    ? 'linear-gradient(90deg, rgba(0, 210, 190, 0.05) 0%, transparent 100%)' 
                    : isPast 
                      ? 'rgba(255, 255, 255, 0.01)' 
                      : 'transparent',
                  transition: 'background 0.2s ease',
                }}
              >
                <td style={{ 
                  paddingLeft: '12px',
                  borderLeft: isNext
                    ? '3px solid var(--accent-teal)'
                    : isPast
                      ? '3px solid var(--text-tertiary)'
                      : '3px solid transparent',
                }}>
                  <span className="data-table__position" style={{
                    background: isNext 
                      ? 'var(--accent-teal)' 
                      : isPast 
                        ? 'var(--bg-raised)' 
                        : 'var(--accent-red)',
                    color: isPast ? 'var(--text-secondary)' : '#fff',
                    border: isPast ? '1px solid var(--border-default)' : '1px solid transparent',
                    borderRadius: '3px',
                    padding: '1px 6px',
                    fontSize: 'var(--fs-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    animation: isNext ? 'next-pulse-glow 2s infinite' : 'none',
                  }}>
                    {ev.round_number}
                  </span>
                </td>
                <td style={{ 
                  fontWeight: isNext ? 600 : 500, 
                  color: 'var(--text-primary)' 
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{ev.event_name}</span>
                    {isNext && (
                      <span className="badge" style={{
                        background: 'var(--accent-teal)',
                        color: 'var(--text-inverted)',
                        fontSize: '9px',
                        padding: '1px 4px',
                        borderRadius: '2px',
                        fontWeight: 'bold',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}>
                        Next
                      </span>
                    )}
                  </div>
                </td>
                <td className="text-secondary" style={{ color: 'var(--text-secondary)' }}>{ev.circuit_name}, {ev.country}</td>
                {/* <td className="text-secondary" style={{ color: 'var(--text-secondary)' }}>{ev.country}</td> */}
                <td style={{ color: 'var(--text-primary)' }}>{formatDate(ev.event_date)}</td>
                <td>
                  {ev.event_format !== 'conventional' && (
                    <span className="badge" style={{
                      background: 'var(--accent-amber)',
                      color: 'var(--text-inverted)',
                      fontSize: 'var(--fs-xs)',
                      opacity: 1,
                    }}>
                      Sprint & Grand Prix
                    </span>
                  )}
                  {ev.event_format === 'conventional' && (
                    <span className="badge" style={{
                      background: 'var(--accent-blue)',
                      color: 'var(--text-inverted)',
                      fontSize: 'var(--fs-xs)',
                      opacity: 1,
                    }}>
                      Grand Prix
                    </span>
                  )}
                </td>
                <td>
                  {ev.winner ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{
                        width: '3px',
                        height: '14px',
                        borderRadius: '1px',
                        background: getDriverColour(ev.winner, ev.winner_team),
                        display: 'inline-block'
                      }} />
                      <span className="mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{ev.winner}</span>
                    </div>
                  ) : '—'}
                </td>
                <td>
                  {ev.sprint_winner ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{
                        width: '3px',
                        height: '14px',
                        borderRadius: '1px',
                        background: getDriverColour(ev.sprint_winner, ev.sprint_winner_team),
                        display: 'inline-block'
                      }} />
                      <span className="mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{ev.sprint_winner}</span>
                    </div>
                  ) : (ev.event_format !== 'conventional' ? '—' : '')}
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
