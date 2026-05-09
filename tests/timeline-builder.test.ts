/**
 * tests/timeline-builder.test.ts
 *
 * Tests for the request timeline builder.
 */

import { buildTimeline, getRequestDuration, getPhasesSummary } from '@/lib/logging/timeline-builder';
import type { EventLog } from '@/lib/logging/event-logger';

function makeEvent(category: string, event: string, timestamp: number, duration?: number): EventLog {
  return {
    id: `evt_${timestamp}`,
    category: category as any,
    event,
    severity: 'INFO',
    timestamp,
    duration,
    requestId: 'req_test',
  };
}

describe('TimelineBuilder', () => {
  test('builds timeline sorted by timestamp', () => {
    const events = [
      makeEvent('ROUTING', 'Model resolved', 1000),
      makeEvent('ACTIVITY', 'Request started', 500),
      makeEvent('ACTIVITY', 'Request completed', 2000),
    ];

    const timeline = buildTimeline(events);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].timestamp).toBe(500);
    expect(timeline[1].timestamp).toBe(1000);
    expect(timeline[2].timestamp).toBe(2000);
  });

  test('infers correct phases from events', () => {
    const events = [
      makeEvent('ACTIVITY', 'Incoming request', 100),
      makeEvent('AUTH', 'Token validated', 150),
      makeEvent('ORCHESTRATOR', 'Orchestrator assigned', 200),
      makeEvent('ROUTING', 'Model resolved', 250),
      makeEvent('RETRY', 'Retrying after 503', 300),
      makeEvent('OVERLOAD', 'Overload recovery', 350),
      makeEvent('ACTIVITY', 'Request completed', 500, 400),
    ];

    const timeline = buildTimeline(events);
    const phases = timeline.map(e => e.phase);

    expect(phases).toContain('REQUEST_STARTED');
    expect(phases).toContain('AUTH_VALIDATED');
    expect(phases).toContain('ORCHESTRATOR_ASSIGNED');
    expect(phases).toContain('ROUTING_RESOLVED');
    expect(phases).toContain('RETRY_TRIGGERED');
    expect(phases).toContain('OVERLOAD_RECOVERY');
    expect(phases).toContain('REQUEST_COMPLETED');
  });

  test('getRequestDuration computes total duration', () => {
    const timeline = buildTimeline([
      makeEvent('ACTIVITY', 'Request started', 1000),
      makeEvent('ACTIVITY', 'Request completed', 3500),
    ]);

    expect(getRequestDuration(timeline)).toBe(2500);
  });

  test('getRequestDuration returns null for single event', () => {
    const timeline = buildTimeline([
      makeEvent('ACTIVITY', 'Request started', 1000),
    ]);
    expect(getRequestDuration(timeline)).toBeNull();
  });

  test('getPhasesSummary detects retries and fallbacks', () => {
    const timeline = buildTimeline([
      makeEvent('ACTIVITY', 'Request started', 100),
      makeEvent('RETRY', 'Retry attempt 2', 200),
      makeEvent('ROUTING', 'Fallback to gemma', 250),
      makeEvent('WEB_SEARCH', 'Searching', 300),
    ]);

    const summary = getPhasesSummary(timeline);
    expect(summary.hasRetries).toBe(true);
    expect(summary.hasFallbacks).toBe(true);
    expect(summary.hasWebSearch).toBe(true);
    expect(summary.hasOverload).toBe(false);
  });

  test('preserves duration in timeline entries', () => {
    const timeline = buildTimeline([
      makeEvent('ROUTING', 'Model call', 100, 1500),
    ]);
    expect(timeline[0].duration).toBe(1500);
  });

  test('handles empty event list', () => {
    const timeline = buildTimeline([]);
    expect(timeline).toHaveLength(0);
    expect(getRequestDuration(timeline)).toBeNull();
  });
});
