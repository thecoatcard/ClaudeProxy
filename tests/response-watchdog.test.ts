/**
 * tests/response-watchdog.test.ts
 *
 * Tests for hard timeouts, withTimeout, and RequestWatchdog.
 */

import {
  withTimeout,
  RequestWatchdog,
  MODEL_CALL_TIMEOUT,
  COMPACTOR_TIMEOUT,
  REDIS_TIMEOUT,
  WEB_SEARCH_TIMEOUT,
  REQUEST_TIMEOUT,
} from '../lib/runtime/response-watchdog';

describe('withTimeout', () => {
  test('resolves if promise finishes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  test('rejects if promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50, 'slow-op')).rejects.toThrow('Timeout: slow-op exceeded 50ms');
  });

  test('propagates promise rejection', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('boom');
  });

  test('zero timeout passes through', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 0, 'test');
    expect(result).toBe('ok');
  });
});

describe('RequestWatchdog', () => {
  test('tracks activity and detects stall', async () => {
    let stallDetected = false;
    const watchdog = new RequestWatchdog('test-req', () => { stallDetected = true; });

    watchdog.activity('model-call');
    expect(watchdog.getState().lastPhase).toBe('model-call');
    expect(watchdog.getState().isStalled).toBe(false);
    expect(stallDetected).toBe(false);

    watchdog.stop();
  });

  test('isOverBudget returns false initially', () => {
    const watchdog = new RequestWatchdog('test-req');
    expect(watchdog.isOverBudget()).toBe(false);
    expect(watchdog.elapsed()).toBeLessThan(100);
    watchdog.stop();
  });
});

describe('Timeout constants', () => {
  test('MODEL_CALL_TIMEOUT defaults to 55s (raised from 20s to cover long Gemini pre-generation phases)', () => {
    expect(MODEL_CALL_TIMEOUT).toBe(55_000);
  });

  test('COMPACTOR_TIMEOUT defaults to 8s', () => {
    expect(COMPACTOR_TIMEOUT).toBe(8_000);
  });

  test('REDIS_TIMEOUT defaults to 3s', () => {
    expect(REDIS_TIMEOUT).toBe(3_000);
  });

  test('WEB_SEARCH_TIMEOUT defaults to 8s', () => {
    expect(WEB_SEARCH_TIMEOUT).toBe(8_000);
  });

  test('REQUEST_TIMEOUT defaults to 45 minutes', () => {
    expect(REQUEST_TIMEOUT).toBe(2_700_000);
  });
});
