/**
 * lib/logging/log-level.ts
 *
 * Log level control for the gateway.
 * Configurable via LOG_LEVEL env var.
 * Production defaults to WARN; dashboard still shows all events from Redis.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
};

/**
 * Get the current log level from environment.
 * Defaults: production → WARN, development → INFO, test → ERROR
 */
export function getLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toUpperCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'production') return 'WARN';
  if (nodeEnv === 'test') return 'ERROR';
  return 'INFO';
}

/**
 * Check if a given severity should be logged to console at the current level.
 */
export function shouldLog(severity: LogLevel): boolean {
  const currentLevel = getLogLevel();
  return LEVEL_ORDER[severity] >= LEVEL_ORDER[currentLevel];
}
