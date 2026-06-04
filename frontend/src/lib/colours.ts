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

/**
 * Smart color lightness adjuster.
 * Converts Hex or RGB to HSL, then lightens or darkens based on original lightness.
 * Keeps colors visible and high contrast on dark backgrounds.
 */
export function adjustColorLightness(color: string, percent: number = 25): string {
  let r = 0, g = 0, b = 0;
  const trimmed = color.trim().toLowerCase();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.substring(1);
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
    } else {
      return color;
    }
  } else if (trimmed.startsWith('rgb')) {
    const match = trimmed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/);
    if (match) {
      r = parseInt(match[1], 10);
      g = parseInt(match[2], 10);
      b = parseInt(match[3], 10);
    } else {
      return color;
    }
  } else {
    return color;
  }

  // Convert RGB to HSL
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
      case gNorm: h = (bNorm - rNorm) / d + 2; break;
      case bNorm: h = (rNorm - gNorm) / d + 4; break;
    }
    h /= 6;
  }

  const hDeg = Math.round(h * 360);
  const sPct = Math.round(s * 100);
  const lPct = Math.round(l * 100);

  // If the color is already dark, we lighten it. If it's light, we darken it.
  const isDark = lPct < 40;
  const direction = isDark ? 1 : -1;
  const adjustAmount = direction * Math.abs(percent);
  let newL = lPct + adjustAmount;

  // Clamp new lightness to [10, 90] to maintain visibility
  if (newL < 10) newL = 10;
  if (newL > 90) newL = 90;

  return `hsl(${hDeg}, ${sPct}%, ${newL}%)`;
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
