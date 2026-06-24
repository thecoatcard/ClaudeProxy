/**
 * lib/logging/log-dedup.ts
 *
 * Deduplicates repeated log events within a time window.
 * Collapses identical events (same category + event text) into a single
 * event with a count, preventing log flood during overload/retry storms.
 */

import type { EventLog } from './event-logger';

interface DedupEntry {
  event: EventLog;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/** Window in ms to consider events as duplicates. */
const DEDUP_WINDOW_MS = 5000;

/** Max entries to track for deduplication. */
const MAX_DEDUP_ENTRIES = 200;

/** In-memory dedup map: key → entry. */
const dedupMap = new Map<string, DedupEntry>();

/** Generate a dedup key from category + event text. */
function dedupKey(event: EventLog): string {
  return `${event.category}::${event.event}`;
}

/**
 * Attempt to deduplicate an event.
 * Returns the event (possibly with count metadata) if it should be emitted,
 * or null if it was collapsed into an existing event.
 */
export function deduplicateEvent(event: EventLog): EventLog | null {
  const key = dedupKey(event);
  const now = Date.now();

  // Cleanup stale entries
  if (dedupMap.size > MAX_DEDUP_ENTRIES) {
    for (const [k, entry] of dedupMap) {
      if (now - entry.lastSeen > DEDUP_WINDOW_MS) {
        dedupMap.delete(k);
      }
    }
  }

  const existing = dedupMap.get(key);

  if (existing && now - existing.lastSeen < DEDUP_WINDOW_MS) {
    // Collapse into existing
    existing.count++;
    existing.lastSeen = now;

    // Every 10th duplicate, emit a summary
    if (existing.count % 10 === 0) {
      return {
        ...event,
        event: `${event.event} (repeated ${existing.count}x in ${Math.round((now - existing.firstSeen) / 1000)}s)`,
        metadata: { ...event.metadata, dedupCount: existing.count },
      };
    }

    return null; // Collapsed — don't emit
  }

  // New entry or expired window
  dedupMap.set(key, {
    event,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  });

  return event;
}

/**
 * Reset dedup state (for testing).
 */
export function resetDedup(): void {
  dedupMap.clear();
}

/**
 * Get current dedup statistics.
 */
export function getDedupStats(): { trackedEvents: number; totalCollapsed: number } {
  let totalCollapsed = 0;
  for (const entry of dedupMap.values()) {
    totalCollapsed += Math.max(0, entry.count - 1);
  }
  return { trackedEvents: dedupMap.size, totalCollapsed };
}
