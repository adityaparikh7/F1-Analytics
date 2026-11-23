/**
 * Race Replay — the weather at the replay's current moment, for the page header.
 */

import React from 'react';
import { CloudRain, Thermometer } from 'lucide-react';
import type { ReplayWeather } from '../lib/api';
import { RAIN_COLOUR } from '../lib/colours';
import { isRaining, weatherAt } from './weather';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function compass(deg: number | null): string {
  if (deg == null) return '';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export const WeatherChip: React.FC<{ weather: ReplayWeather | null; time: number }> = ({ weather, time }) => {
  const w = weatherAt(weather, time);
  if (!w) return null;
  const raining = isRaining(weather, time);
  const parts = [
    w.air != null ? `Air ${Math.round(w.air)}°` : null,
    w.track != null ? `Track ${Math.round(w.track)}°` : null,
    w.humidity != null ? `${Math.round(w.humidity)}%` : null,
    w.wind_speed != null ? `${w.wind_speed.toFixed(1)} m/s ${compass(w.wind_dir)}`.trim() : null,
  ].filter(Boolean);

  return (
    <span
      className="mono"
      title={`Weather (${weather?.source === 'openf1' ? 'OpenF1' : 'F1 live timing'}): air and track temperature, humidity, wind`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${raining ? RAIN_COLOUR : 'var(--border-default)'}`,
        color: raining ? RAIN_COLOUR : 'var(--text-secondary)',
        fontSize: 'var(--fs-xs)',
        whiteSpace: 'nowrap',
      }}
    >
      {raining ? <CloudRain size={13} /> : <Thermometer size={13} />}
      {raining && <span style={{ fontWeight: 700 }}>Rain</span>}
      {parts.join(' · ')}
    </span>
  );
};
