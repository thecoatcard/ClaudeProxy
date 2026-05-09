/**
 * lib/logging/noise-filter.ts
 *
 * Filters out noisy, irrelevant events from the logging pipeline.
 * Prevents dashboard polling, static asset logs, health checks,
 * and browser warnings from polluting the event stream.
 */

import type { EventLog } from './event-logger';

/** Patterns that indicate noise to filter out. */
const NOISE_PATTERNS = [
  // Next.js static/dev logs
  /^GET\s+\/_next\//,
  /^GET\s+\/favicon/,
  /^GET\s+\/static\//,
  /^GET\s+\/__nextjs/,
  // Admin polling
  /admin.*polling/i,
  /GET\s+\/api\/admin\//,
  // Health checks
  /health.?check/i,
  /readiness/i,
  /liveness/i,
  // Browser warnings
  /\[Fast Refresh\]/,
  /\[webpack\]/,
  /\[HMR\]/,
];

/**
 * Returns true if the event should be filtered out (not stored or logged).
 */
export function shouldFilter(event: EventLog): boolean {
  const text = event.event;
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Check if a raw log line is noise (for filtering console output).
 */
export function isNoisyLogLine(line: string): boolean {
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}
