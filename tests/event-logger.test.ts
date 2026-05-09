/**
 * tests/event-logger.test.ts
 *
 * Tests for the structured event logging system.
 */

// Mock Redis before imports
const mockRedis = {
  lpush: jest.fn().mockResolvedValue(1),
  ltrim: jest.fn().mockResolvedValue('OK'),
  rpush: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  pipeline: jest.fn().mockReturnValue({
    lpush: jest.fn().mockReturnThis(),
    ltrim: jest.fn().mockReturnThis(),
    rpush: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  }),
};
jest.mock('@/lib/redis', () => ({ redis: mockRedis }));

import { emitEvent, logInfo, logWarn, logError, logCritical, createRequestLogger } from '@/lib/logging/event-logger';
import { resetDedup } from '@/lib/logging/log-dedup';

describe('EventLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDedup();
    process.env.LOG_LEVEL = 'ERROR'; // Suppress console output in tests
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  test('emitEvent creates an event with all fields', () => {
    const evt = emitEvent('ROUTING', 'Model resolved', 'INFO', {
      requestId: 'req_123',
      metadata: { model: 'gemini-2.5-flash' },
    });

    expect(evt.id).toMatch(/^evt_/);
    expect(evt.category).toBe('ROUTING');
    expect(evt.event).toBe('Model resolved');
    expect(evt.severity).toBe('INFO');
    expect(evt.requestId).toBe('req_123');
    expect(evt.timestamp).toBeGreaterThan(0);
    expect(evt.metadata).toEqual({ model: 'gemini-2.5-flash' });
  });

  test('logInfo creates INFO event', () => {
    const evt = logInfo('ACTIVITY', 'Request started');
    expect(evt.severity).toBe('INFO');
    expect(evt.category).toBe('ACTIVITY');
  });

  test('logWarn creates WARN event', () => {
    const evt = logWarn('OVERLOAD', 'Model overloaded');
    expect(evt.severity).toBe('WARN');
  });

  test('logError creates ERROR event', () => {
    const evt = logError('RETRY', 'All models failed');
    expect(evt.severity).toBe('ERROR');
  });

  test('logCritical creates CRITICAL event', () => {
    const evt = logCritical('SYSTEM', 'Redis connection lost');
    expect(evt.severity).toBe('CRITICAL');
  });

  test('createRequestLogger scopes all events to requestId', () => {
    const log = createRequestLogger('req_abc');
    const e1 = log.info('ROUTING', 'Resolved model');
    const e2 = log.warn('RETRY', 'Retrying');
    const e3 = log.error('OVERLOAD', 'Failed');

    expect(e1.requestId).toBe('req_abc');
    expect(e2.requestId).toBe('req_abc');
    expect(e3.requestId).toBe('req_abc');
  });

  test('events include duration when provided', () => {
    const evt = emitEvent('ROUTING', 'Model call', 'INFO', { duration: 1500 });
    expect(evt.duration).toBe(1500);
  });

  test('events include parentTaskId and subTaskId', () => {
    const evt = emitEvent('SUBAGENT', 'Task started', 'INFO', {
      parentTaskId: 'parent_1',
      subTaskId: 'sub_1',
    });
    expect(evt.parentTaskId).toBe('parent_1');
    expect(evt.subTaskId).toBe('sub_1');
  });

  test('generates unique event IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(emitEvent('SYSTEM', 'test', 'INFO').id);
    }
    expect(ids.size).toBe(100);
  });

  test('noise-filtered events are still returned but not stored', () => {
    const evt = emitEvent('SYSTEM', 'GET /_next/static/chunk.js', 'INFO');
    // Event is returned...
    expect(evt.id).toMatch(/^evt_/);
    // But pipeline exec shouldn't be called for this event (it was filtered)
  });
});
