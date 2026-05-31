/**
 * F1 Pitwall — Formatting Utilities
 *
 * Lap time, gap, and tyre age formatters.
 * All data display values should use these.
 */

/**
 * Format seconds to lap time string: "1:23.456"
 */
export function formatLapTime(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
  }
  return secs.toFixed(3);
}

/**
 * Format gap to leader: "+1.234" or "+1 Lap"
 */
export function formatGap(gap: string | number | null | undefined): string {
  if (gap == null) return '—';
  if (typeof gap === 'string') return gap;
  if (gap === 0) return 'Leader';
  return `+${gap.toFixed(3)}`;
}

/**
 * Format position: "P1", "P2", etc.
 */
export function formatPosition(pos: number | null | undefined): string {
  if (pos == null) return '—';
  return `P${pos}`;
}

/**
 * Format sector time in seconds: "23.456"
 */
export function formatSectorTime(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '—';
  return seconds.toFixed(3);
}

/**
 * Format points: "25" or "0.5"
 */
export function formatPoints(points: number | null | undefined): string {
  if (points == null) return '—';
  return points % 1 === 0 ? String(points) : points.toFixed(1);
}

/**
 * Format date: "Mar 16" or "Mar 16, 2025"
 */
export function formatDate(dateStr: string | null | undefined, includeYear: boolean = false): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const month = date.toLocaleString('en', { month: 'short' });
  const day = date.getDate();
  if (includeYear) {
    return `${month} ${day}, ${date.getFullYear()}`;
  }
  return `${month} ${day}`;
}

/**
 * Compound display name: "S", "M", "H", "I", "W"
 */
export function formatCompound(compound: string | null | undefined): string {
  if (!compound) return '?';
  const map: Record<string, string> = {
    'SOFT': 'S',
    'MEDIUM': 'M',
    'HARD': 'H',
    'INTERMEDIATE': 'I',
    'WET': 'W',
  };
  return map[compound.toUpperCase()] || compound.charAt(0);
}

/**
 * Session type display name
 */
export function formatSessionType(type: string): string {
  const map: Record<string, string> = {
    'FP1': 'Practice 1',
    'FP2': 'Practice 2',
    'FP3': 'Practice 3',
    'Q': 'Qualifying',
    'SQ': 'Sprint Qualifying',
    'S': 'Sprint',
    'SS': 'Sprint Shootout',
    'R': 'Race',
  };
  return map[type] || type;
}

/**
 * Get Pace Rating based on delta to fastest
 */
export function getPaceRating(delta: number): string {
  if (delta <= 0.2) return 'Elite';
  if (delta <= 1.0) return 'Competitive';
  if (delta <= 2.5) return 'Midfield';
  if (delta <= 3.0) return 'Backmarkers';
  return 'Off Pace';
}

/**
 * Calculate 107% threshold for a given fastest lap (in seconds)
 */
export function getProperLapThreshold(fastestLap: number): number {
  return fastestLap * 1.07;
}
