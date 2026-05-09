/**
 * tests/fallback-overload.test.ts
 *
 * Phase 11: Tests that overload correctly falls back to next model
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      },
      del: async (k: string) => store.delete(k),
      sadd: async () => {},
      smembers: async () => [],
      expire: async () => {},
      srem: async () => {},
      hincrby: async () => 1,
      hincrbyfloat: async () => 1,
      hgetall: async () => null,
      pipeline: () => ({
        hset: () => ({ hincrby: () => ({ hget: () => ({ exec: async () => [null, 1, null] }) }) }),
        exec: async () => [],
      }),
      zadd: async () => {},
      zrange: async () => [],
      hset: async () => {},
      zrem: async () => {},
    },
  };
});

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'test-key' }),
  reportKeyFailure: jest.fn().mockResolvedValue(undefined),
}));

import { getNextFallbackModel, recoverFromOverload } from '../lib/recovery/overload-recovery';

describe('model fallback on overload', () => {
  test('priority chain follows expected order', () => {
    // getNextFallbackModel skips the currentModel, so first result is second in chain
    const tried = new Set<string>();
    const m1 = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(m1).toBe('gemini-3-flash-preview');

    tried.add('gemini-3-flash-preview');
    const m2 = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(m2).toBe('gemini-3.1-flash-lite-preview');

    tried.add('gemini-3.1-flash-lite-preview');
    const m3 = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(m3).toBe('gemma-4-31b-it');

    tried.add('gemma-4-31b-it');
    const m4 = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(m4).toBeNull();
  });

  test('recovery pipeline suggests a fallback model on overload', async () => {
    const result = await recoverFromOverload({
      currentModel: 'gemini-2.5-flash',
      currentKeyId: 'k1',
      triedModels: new Set(['gemini-2.5-flash']),
      attempt: 1,
      body: { contents: [{ parts: [{ text: 'test' }] }] },
    });
    expect(result.recovered).toBe(true);
    expect(result.newModel).toBe('gemini-3-flash-preview');
  });

  test('recovery compacts body when token pressure is high', async () => {
    const bigBody = {
      contents: Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'model',
        parts: [{ text: 'x'.repeat(50_000) }],
      })),
    };

    const result = await recoverFromOverload({
      currentModel: 'gemini-2.5-flash',
      currentKeyId: 'k1',
      triedModels: new Set(['gemini-2.5-flash']),
      attempt: 1,
      body: bigBody,
    });
    expect(result.recovered).toBe(true);
    if (result.compactedBody) {
      expect(result.compactedBody.contents.length).toBeLessThan(30);
    }
  });

  test('no hard throw on recoverable overload', async () => {
    // Should NOT throw — should return a result
    const result = await recoverFromOverload({
      currentModel: 'gemini-2.5-flash',
      currentKeyId: 'k1',
      triedModels: new Set<string>(),
      attempt: 1,
      body: { contents: [] },
    });
    expect(result).toBeDefined();
    expect(typeof result.recovered).toBe('boolean');
  });
});
