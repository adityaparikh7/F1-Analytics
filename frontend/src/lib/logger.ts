/**
 * F1 Pitwall — Frontend Logging Utility
 * 
 * Provides structured logging with levels and color-coded console output.
 * Suppresses DEBUG logs in production environments.
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const IS_PROD = import.meta.env.MODE === 'production';

// Colors for the console (using CSS string substitutions)
const COLORS: Record<LogLevel, string> = {
  DEBUG: 'color: #888; font-style: italic;',
  INFO: 'color: #3b82f6; font-weight: bold;',
  WARN: 'color: #eab308; font-weight: bold;',
  ERROR: 'color: #ef4444; font-weight: bold;',
};

class Logger {
  private format(level: LogLevel, message: string): [string, string, string] {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    return [`[%c${level}%c] ${timestamp} | ${message}`, COLORS[level], 'color: inherit;'];
  }

  debug(message: string, ...args: any[]): void {
    if (IS_PROD) return;
    const [fmt, color, reset] = this.format('DEBUG', message);
    console.debug(fmt, color, reset, ...args);
  }

  info(message: string, ...args: any[]): void {
    const [fmt, color, reset] = this.format('INFO', message);
    console.info(fmt, color, reset, ...args);
  }

  warn(message: string, ...args: any[]): void {
    const [fmt, color, reset] = this.format('WARN', message);
    console.warn(fmt, color, reset, ...args);
  }

  error(message: string, ...args: any[]): void {
    const [fmt, color, reset] = this.format('ERROR', message);
    console.error(fmt, color, reset, ...args);
  }
}

export const logger = new Logger();
