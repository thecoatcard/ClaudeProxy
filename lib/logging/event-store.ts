/**
 * lib/logging/event-store.ts
 *
 * Redis-backed storage for structured events.
 * Events stored with 24h TTL for dashboard retrieval.
 */

import { redis } from '@/lib/redis';
import type { EventLog, EventCategory, EventSeverity } from './event-logger';

/** Redis key for the main event stream. */
const EVENT_STREAM_KEY = 'events:stream';

/** Redis key prefix for request-scoped events. */
const REQUEST_EVENTS_PREFIX = 'events:req:';

/** Maximum events to keep in the stream. */
const MAX_STREAM_SIZE = 5000;

/** TTL for request-scoped event lists (24h). */
const REQUEST_EVENTS_TTL = 86400;

/**
 * Store an event in Redis.
 * - Appends to the global event stream (capped list)
 * - If requestId present, also indexes under request key
 */
export async function storeEvent(event: EventLog): Promise<void> {
  const json = JSON.stringify(event);
  const pipeline = redis.pipeline();

  // Global stream
  pipeline.lpush(EVENT_STREAM_KEY, json);
  pipeline.ltrim(EVENT_STREAM_KEY, 0, MAX_STREAM_SIZE - 1);

  // Request-scoped index
  if (event.requestId) {
    const reqKey = `${REQUEST_EVENTS_PREFIX}${event.requestId}`;
    pipeline.rpush(reqKey, json);
    pipeline.expire(reqKey, REQUEST_EVENTS_TTL);
  }

  await pipeline.exec();
}

/**
 * Retrieve recent events from the global stream.
 */
export async function getRecentEvents(
  limit = 100,
  filters?: {
    category?: EventCategory;
    severity?: EventSeverity;
    requestId?: string;
    search?: string;
  },
): Promise<EventLog[]> {
  // If filtering by requestId, use the request-scoped index
  if (filters?.requestId) {
    return getRequestEvents(filters.requestId);
  }

  // Fetch from global stream — read more than limit to account for filtering
  const fetchSize = filters ? Math.min(limit * 3, MAX_STREAM_SIZE) : limit;
  const raw = await redis.lrange(EVENT_STREAM_KEY, 0, fetchSize - 1);

  const events: EventLog[] = [];
  for (const item of raw) {
    try {
      const evt = JSON.parse(item) as EventLog;

      // Apply filters
      if (filters?.category && evt.category !== filters.category) continue;
      if (filters?.severity && evt.severity !== filters.severity) continue;
      if (filters?.search && !evt.event.toLowerCase().includes(filters.search.toLowerCase())) continue;

      events.push(evt);
      if (events.length >= limit) break;
    } catch {
      /* skip corrupt entries */
    }
  }

  return events;
}

/**
 * Retrieve all events for a specific request.
 */
export async function getRequestEvents(requestId: string): Promise<EventLog[]> {
  const reqKey = `${REQUEST_EVENTS_PREFIX}${requestId}`;
  const raw = await redis.lrange(reqKey, 0, -1);

  const events: EventLog[] = [];
  for (const item of raw) {
    try {
      events.push(JSON.parse(item) as EventLog);
    } catch {
      /* skip corrupt */
    }
  }

  return events;
}

/**
 * Get event count summary by category and severity.
 */
export async function getEventSummary(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
}> {
  const raw = await redis.lrange(EVENT_STREAM_KEY, 0, MAX_STREAM_SIZE - 1);

  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const item of raw) {
    try {
      const evt = JSON.parse(item) as EventLog;
      byCategory[evt.category] = (byCategory[evt.category] || 0) + 1;
      bySeverity[evt.severity] = (bySeverity[evt.severity] || 0) + 1;
    } catch {
      /* skip */
    }
  }

  return { total: raw.length, byCategory, bySeverity };
}

/**
 * Clear all stored events.
 */
export async function clearEvents(): Promise<void> {
  await redis.del(EVENT_STREAM_KEY);
}
