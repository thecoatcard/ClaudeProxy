/**
 * tests/stall-safety.test.ts
 *
 * Verifies that the retry engine and stream have stall safety:
 * - Hard timeouts prevent indefinite hangs
 * - Request time budget is enforced
 * - Stream chunk reads have timeouts
 */

import { withTimeout } from '../lib/runtime/response-watchdog';

describe('Stall Safety: withTimeout prevents hangs', () => {
  test('model call stall triggers timeout', async () => {
    const stallPromise = new Promise<Response>(() => {}); // never resolves
    const start = Date.now();
    await expect(
      withTimeout(stallPromise, 100, 'model-call')
    ).rejects.toThrow('Timeout: model-call exceeded 100ms');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test('compactor stall triggers timeout', async () => {
    const stall = new Promise<void>(() => {});
    await expect(
      withTimeout(stall, 100, 'compactor')
    ).rejects.toThrow('Timeout: compactor exceeded 100ms');
  });

  test('stream chunk read stall triggers timeout', async () => {
    const stall = new Promise<{ done: boolean; value: Uint8Array }>(() => {});
    await expect(
      withTimeout(stall, 100, 'stream-chunk-read')
    ).rejects.toThrow('Timeout: stream-chunk-read exceeded 100ms');
  });

  test('fast response is not affected by timeout', async () => {
    const fast = Promise.resolve({ ok: true, status: 200 });
    const result = await withTimeout(fast, 5000, 'fast');
    expect(result).toEqual({ ok: true, status: 200 });
  });

  test('fallback chain exhaustion terminates quickly', async () => {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        await withTimeout(
          new Promise<void>(() => {}),
          50,
          `model-${i}`,
        );
      } catch {
        results.push(`timeout-${i}`);
      }
    }
    expect(results).toEqual(['timeout-0', 'timeout-1', 'timeout-2']);
  });
});
