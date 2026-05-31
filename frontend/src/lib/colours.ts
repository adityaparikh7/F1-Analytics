/**
 * F1 Pitwall — Driver and Compound Colour Maps
 *
 * Central colour config consumed by all panels.
 * Never hardcode driver colours in individual components.
 */

// ── Team Colours ────────────────────────────────────────────────────

export const TEAM_COLOURS: Record<string, string> = {
  'Red Bull Racing': '#002d6c',
  'Red Bull': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Racing Point': 'rgb(255, 81, 252)',
  'Alpine': '#ff00fbff',
  'Williams': '#64C4FF',
  'RB': '#6692FF',
  'Racing Bulls': '#6692FF',
  'AlphaTauri': '#6692FF',
  'Haas F1 Team': '#B6BABD',
  'Haas': '#B6BABD',
  'Kick Sauber': '#52E252',
  'Sauber': '#52E252',
  'Alfa Romeo': '#6a0303',
  'Alfa Romeo Racing': '#6a0303',
  'Audi': '#ff2911ff',  
  'Cadillac': 'rgb(255, 225, 0)',
  'Renault': 'rgb(255, 255, 0)',
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

export function getTeamColour(team: string | null | undefined): string {
  if (!team) return '#888890';
  return TEAM_COLOURS[team] || '#888890';
}

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
