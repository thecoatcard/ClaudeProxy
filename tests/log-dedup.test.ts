/**
 * tests/log-dedup.test.ts
 *
 * Tests for log deduplication.
 */

import { deduplicateEvent, resetDedup, getDedupStats } from '@/lib/logging/log-dedup';
import type { EventLog } from '@/lib/logging/event-logger';

function makeEvent(category: string, event: string): EventLog {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2, 6)}`,
    category: category as any,
    event,
    severity: 'INFO',
    timestamp: Date.now(),
  };
}

describe('LogDedup', () => {
  beforeEach(() => {
    resetDedup();
  });

  test('first occurrence is always emitted', () => {
    const evt = makeEvent('ROUTING', 'Model resolved');
    const result = deduplicateEvent(evt);
    expect(result).not.toBeNull();
    expect(result!.event).toBe('Model resolved');
  });

  test('second identical event is collapsed (returns null)', () => {
    const evt1 = makeEvent('ROUTING', 'Model resolved');
    const evt2 = makeEvent('ROUTING', 'Model resolved');

    deduplicateEvent(evt1);
    const result = deduplicateEvent(evt2);
    expect(result).toBeNull();
  });

  test('different events are not collapsed', () => {
    const evt1 = makeEvent('ROUTING', 'Model A resolved');
    const evt2 = makeEvent('ROUTING', 'Model B resolved');

    const r1 = deduplicateEvent(evt1);
    const r2 = deduplicateEvent(evt2);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  test('different categories are not collapsed', () => {
    const evt1 = makeEvent('ROUTING', 'Same event');
    const evt2 = makeEvent('RETRY', 'Same event');

    const r1 = deduplicateEvent(evt1);
    const r2 = deduplicateEvent(evt2);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  test('every 10th duplicate emits a summary', () => {
    const evts: (EventLog | null)[] = [];
    for (let i = 0; i < 10; i++) {
      evts.push(deduplicateEvent(makeEvent('RETRY', 'Overloaded')));
    }

    // First is emitted, 2-9 are null, 10th is emitted with count
    expect(evts[0]).not.toBeNull();
    for (let i = 1; i < 9; i++) {
      expect(evts[i]).toBeNull();
    }
    expect(evts[9]).not.toBeNull();
    expect(evts[9]!.event).toContain('repeated 10x');
  });

  test('getDedupStats reports collapsed count', () => {
    for (let i = 0; i < 5; i++) {
      deduplicateEvent(makeEvent('RETRY', 'Same event'));
    }

    const stats = getDedupStats();
    expect(stats.trackedEvents).toBe(1);
    expect(stats.totalCollapsed).toBe(4); // 5 events - 1 first = 4 collapsed
  });

  test('resetDedup clears all state', () => {
    deduplicateEvent(makeEvent('ROUTING', 'Test'));
    resetDedup();
    const stats = getDedupStats();
    expect(stats.trackedEvents).toBe(0);
  });
});
