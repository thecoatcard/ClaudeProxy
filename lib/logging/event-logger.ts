/**
 * lib/logging/event-logger.ts
 *
 * Structured event logging system.
 * Replaces raw console.log/warn/error with typed, categorized events.
 * Events are stored in Redis and optionally emitted to console based on log level.
 */

import { shouldLog } from './log-level';
import { storeEvent } from './event-store';
import { shouldFilter } from './noise-filter';
import { deduplicateEvent } from './log-dedup';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EventCategory =
  | 'ORCHESTRATOR'
  | 'ROUTING'
  | 'RETRY'
  | 'OVERLOAD'
  | 'KEY_ROTATION'
  | 'WEB_SEARCH'
  | 'COMPACTION'
  | 'SUBAGENT'
  | 'RECOVERY'
  | 'ACTIVITY'
  | 'STREAM'
  | 'AUTH'
  | 'MEMORY'
  | 'SYSTEM'
  | 'RETRIEVAL'
  | 'MODEL_CALL'
  | 'KEY_RACE'
  | 'MODEL_RACE';

export type EventSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface EventLog {
  id: string;
  requestId?: string;
  parentTaskId?: string;
  subTaskId?: string;
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  timestamp: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

// ─── ID Generation ───────────────────────────────────────────────────────────

let counter = 0;
function generateEventId(): string {
  const ts = Date.now().toString(36);
  const c = (counter++).toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `evt_${ts}_${c}_${r}`;
}

// ─── Console Formatting ─────────────────────────────────────────────────────

const SEVERITY_PREFIX: Record<EventSeverity, string> = {
  INFO: '\x1b[36m[INFO]\x1b[0m',
  WARN: '\x1b[33m[WARN]\x1b[0m',
  ERROR: '\x1b[31m[ERROR]\x1b[0m',
  CRITICAL: '\x1b[35m[CRITICAL]\x1b[0m',
};

function formatForConsole(evt: EventLog): string {
  const prefix = SEVERITY_PREFIX[evt.severity];
  const cat = `[${evt.category}]`;
  const reqId = evt.requestId ? ` req=${evt.requestId.slice(0, 8)}` : '';
  const dur = evt.duration ? ` (${evt.duration}ms)` : '';
  return `${prefix} ${cat}${reqId} ${evt.event}${dur}`;
}

// ─── Core Logger ─────────────────────────────────────────────────────────────

/**
 * Emit a structured event.
 * 1. Check noise filter
 * 2. Deduplicate
 * 3. Store in Redis
 * 4. Optionally emit to console based on log level
 */
export function emitEvent(
  category: EventCategory,
  event: string,
  severity: EventSeverity,
  opts: {
    requestId?: string;
    parentTaskId?: string;
    subTaskId?: string;
    duration?: number;
    metadata?: Record<string, unknown>;
  } = {},
): EventLog {
  const log: EventLog = {
    id: generateEventId(),
    requestId: opts.requestId,
    parentTaskId: opts.parentTaskId,
    subTaskId: opts.subTaskId,
    category,
    event,
    severity,
    timestamp: Date.now(),
    duration: opts.duration,
    metadata: opts.metadata,
  };

  // Noise filter — drop irrelevant events
  if (shouldFilter(log)) {
    return log;
  }

  // Dedup — collapse repeated identical events
  const deduped = deduplicateEvent(log);
  if (!deduped) {
    return log; // Collapsed into existing event
  }

  // Store in Redis (fire-and-forget)
  storeEvent(deduped).catch(() => {});

  // Console output based on log level
  if (shouldLog(severity)) {
    const formatted = formatForConsole(deduped);
    if (severity === 'ERROR' || severity === 'CRITICAL') {
      console.error(formatted);
    } else if (severity === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  return deduped;
}

// ─── Convenience Helpers ─────────────────────────────────────────────────────

export function logInfo(category: EventCategory, event: string, opts?: Parameters<typeof emitEvent>[3]) {
  return emitEvent(category, event, 'INFO', opts);
}

export function logWarn(category: EventCategory, event: string, opts?: Parameters<typeof emitEvent>[3]) {
  return emitEvent(category, event, 'WARN', opts);
}

export function logError(category: EventCategory, event: string, opts?: Parameters<typeof emitEvent>[3]) {
  return emitEvent(category, event, 'ERROR', opts);
}

export function logCritical(category: EventCategory, event: string, opts?: Parameters<typeof emitEvent>[3]) {
  return emitEvent(category, event, 'CRITICAL', opts);
}

// ─── Request-Scoped Logger ──────────────────────────────────────────────────

export function createRequestLogger(requestId: string) {
  return {
    info: (category: EventCategory, event: string, opts?: Omit<Parameters<typeof emitEvent>[3], 'requestId'>) =>
      logInfo(category, event, { ...opts, requestId }),
    warn: (category: EventCategory, event: string, opts?: Omit<Parameters<typeof emitEvent>[3], 'requestId'>) =>
      logWarn(category, event, { ...opts, requestId }),
    error: (category: EventCategory, event: string, opts?: Omit<Parameters<typeof emitEvent>[3], 'requestId'>) =>
      logError(category, event, { ...opts, requestId }),
    critical: (category: EventCategory, event: string, opts?: Omit<Parameters<typeof emitEvent>[3], 'requestId'>) =>
      logCritical(category, event, { ...opts, requestId }),
  };
}
