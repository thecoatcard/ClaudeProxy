/**
 * lib/logging/timeline-builder.ts
 *
 * Builds request lifecycle timelines from stored events.
 * Tracks: request started → orchestrator assigned → routing resolved →
 * subagent started → tool execution → retry → fallback → merge → completed.
 */

import type { EventLog } from './event-logger';

export interface TimelineEntry {
  timestamp: number;
  phase: RequestPhase;
  event: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export type RequestPhase =
  | 'REQUEST_STARTED'
  | 'AUTH_VALIDATED'
  | 'ORCHESTRATOR_ASSIGNED'
  | 'ROUTING_RESOLVED'
  | 'SUBAGENT_STARTED'
  | 'TOOL_EXECUTION'
  | 'MODEL_CALL'
  | 'RETRY_TRIGGERED'
  | 'FALLBACK_USED'
  | 'OVERLOAD_RECOVERY'
  | 'COMPACTION'
  | 'WEB_SEARCH'
  | 'MERGE_COMPLETED'
  | 'STREAM_STARTED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED';

/**
 * Infer the request phase from an event's category and text.
 */
function inferPhase(event: EventLog): RequestPhase {
  const text = event.event.toLowerCase();
  const cat = event.category;

  if (text.includes('request started') || text.includes('incoming request')) return 'REQUEST_STARTED';
  if (cat === 'AUTH') return 'AUTH_VALIDATED';
  if (cat === 'ORCHESTRATOR' && text.includes('assign')) return 'ORCHESTRATOR_ASSIGNED';
  if (cat === 'ROUTING' && text.includes('resolv')) return 'ROUTING_RESOLVED';
  if (cat === 'SUBAGENT' && text.includes('start')) return 'SUBAGENT_STARTED';
  if (text.includes('tool') && text.includes('execut')) return 'TOOL_EXECUTION';
  if (cat === 'RETRY') return 'RETRY_TRIGGERED';
  if (text.includes('fallback')) return 'FALLBACK_USED';
  if (cat === 'OVERLOAD' || cat === 'RECOVERY') return 'OVERLOAD_RECOVERY';
  if (cat === 'COMPACTION') return 'COMPACTION';
  if (cat === 'WEB_SEARCH') return 'WEB_SEARCH';
  if (text.includes('merge')) return 'MERGE_COMPLETED';
  if (cat === 'STREAM') return 'STREAM_STARTED';
  if (cat === 'MODEL_CALL') return 'MODEL_CALL';
  if (cat === 'RETRIEVAL') return 'MODEL_CALL';
  if (text.includes('completed') || text.includes('finished')) return 'REQUEST_COMPLETED';
  if (text.includes('failed') || text.includes('error')) return 'REQUEST_FAILED';

  return 'MODEL_CALL';
}

/**
 * Build a timeline from a list of request-scoped events.
 * Events should be pre-sorted by timestamp (ascending).
 */
export function buildTimeline(events: EventLog[]): TimelineEntry[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  return sorted.map((evt) => ({
    timestamp: evt.timestamp,
    phase: inferPhase(evt),
    event: evt.event,
    duration: evt.duration,
    metadata: evt.metadata,
  }));
}

/**
 * Compute the total request duration from a timeline.
 */
export function getRequestDuration(timeline: TimelineEntry[]): number | null {
  if (timeline.length < 2) return null;
  return timeline[timeline.length - 1].timestamp - timeline[0].timestamp;
}

/**
 * Extract a summary of phases present in a timeline.
 */
export function getPhasesSummary(timeline: TimelineEntry[]): {
  phases: RequestPhase[];
  hasRetries: boolean;
  hasFallbacks: boolean;
  hasOverload: boolean;
  hasWebSearch: boolean;
  hasCompaction: boolean;
} {
  const phases = new Set<RequestPhase>();
  for (const entry of timeline) {
    phases.add(entry.phase);
  }

  return {
    phases: Array.from(phases),
    hasRetries: phases.has('RETRY_TRIGGERED'),
    hasFallbacks: phases.has('FALLBACK_USED'),
    hasOverload: phases.has('OVERLOAD_RECOVERY'),
    hasWebSearch: phases.has('WEB_SEARCH'),
    hasCompaction: phases.has('COMPACTION'),
  };
}
