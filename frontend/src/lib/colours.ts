/**
 * F1 Pitwall — Driver and Compound Colour Maps
 *
 * Central colour config consumed by all panels.
 * Never hardcode driver colours in individual components.
 */

// ── Team Colours ────────────────────────────────────────────────────

export const TEAM_COLOURS: Record<string, string> = {
  'Red Bull Racing': '#3671C6',
  'Red Bull': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Alpine': '#0093CC',
  'Williams': '#64C4FF',
  'RB': '#6692FF',
  'Racing Bulls': '#6692FF',
  'Haas F1 Team': '#B6BABD',
  'Haas': '#B6BABD',
  'Kick Sauber': '#52E252',
  'Sauber': '#52E252',
  'Cadillac': '#3F3F3F',
};

// ── Driver → Team Mapping (2025 season) ─────────────────────────────

export const DRIVER_TEAMS: Record<string, string> = {
  'VER': 'Red Bull Racing',
  'LAW': 'Red Bull Racing',
  'LEC': 'Ferrari',
  'HAM': 'Ferrari',
  'RUS': 'Mercedes',
  'ANT': 'Mercedes',
  'NOR': 'McLaren',
  'PIA': 'McLaren',
  'ALO': 'Aston Martin',
  'STR': 'Aston Martin',
  'GAS': 'Alpine',
  'DOO': 'Alpine',
  'ALB': 'Williams',
  'SAI': 'Williams',
  'TSU': 'Racing Bulls',
  'HAD': 'Racing Bulls',
  'HUL': 'Haas F1 Team',
  'BEA': 'Haas F1 Team',
  'BOT': 'Kick Sauber',
  'ZHO': 'Kick Sauber',
};

export function getDriverColour(driver: string, team?: string | null): string {
  // Try team first (most reliable)
  if (team) {
    const teamColour = TEAM_COLOURS[team];
    if (teamColour) return teamColour;
  }

  // Try driver → team mapping
  const mappedTeam = DRIVER_TEAMS[driver];
  if (mappedTeam) {
    return TEAM_COLOURS[mappedTeam] || '#888890';
  }

  return '#888890'; // Fallback grey
}

// ── Compound Colours ────────────────────────────────────────────────

export const COMPOUND_COLOURS: Record<string, string> = {
  'SOFT': '#E8002D',
  'MEDIUM': '#FFC906',
  'HARD': '#EBEBEB',
  'INTERMEDIATE': '#39B54A',
  'WET': '#0067FF',
  'UNKNOWN': '#888890',
};

export function getCompoundColour(compound: string | null | undefined): string {
  if (!compound) return COMPOUND_COLOURS.UNKNOWN;
  return COMPOUND_COLOURS[compound.toUpperCase()] || COMPOUND_COLOURS.UNKNOWN;
}
