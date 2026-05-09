/**
 * tests/overload-recovery.test.ts
 *
 * Tests for lib/recovery/overload-recovery.ts
 * Phase 11: overload classification, compaction, backoff, token pressure, full pipeline
 */

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'test-key' }),
  reportKeyFailure: jest.fn().mockResolvedValue(undefined),
  recordKeyUsage: jest.fn().mockResolvedValue(undefined),
}));

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

import {
  isOverloadError,
  isRecoverableError,
  getNextFallbackModel,
  compactBodyForOverload,
  detectTokenPressure,
  computeOverloadBackoff,
  recoverFromOverload,
  cooldownOverloadedKey,
  rotateToFreshKey,
  savePartialStreamState,
  getPartialStreamState,
} from '../lib/recovery/overload-recovery';

describe('isOverloadError', () => {
  test('detects overloaded_error string', () => {
    expect(isOverloadError('overloaded_error')).toBe(true);
  });

  test('detects 503 status', () => {
    expect(isOverloadError({ status: 503, message: 'Service unavailable' })).toBe(true);
  });

  test('detects resource_exhausted', () => {
    expect(isOverloadError('resource_exhausted: quota exceeded')).toBe(true);
  });

  test('detects rate limit', () => {
    expect(isOverloadError('rate limit exceeded for this model')).toBe(true);
  });

  test('does not detect normal 400', () => {
    expect(isOverloadError({ status: 400, message: 'Bad request' })).toBe(false);
  });

  test('detects quota exceeded', () => {
    expect(isOverloadError('quota exceeded')).toBe(true);
  });
});

describe('isRecoverableError', () => {
  test('overload is recoverable', () => {
    expect(isRecoverableError('overloaded_error')).toBe(true);
  });

  test('429 is recoverable', () => {
    expect(isRecoverableError({ status: 429 })).toBe(true);
  });

  test('503 is recoverable', () => {
    expect(isRecoverableError({ status: 503 })).toBe(true);
  });

  test('400 is not recoverable', () => {
    expect(isRecoverableError({ status: 400, message: 'Bad format' })).toBe(false);
  });
});

describe('getNextFallbackModel', () => {
  test('returns next model not in tried set', () => {
    const tried = new Set(['gemini-2.5-flash']);
    const next = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(next).toBeTruthy();
    expect(next).not.toBe('gemini-2.5-flash');
  });

  test('returns null when all models tried', () => {
    const tried = new Set([
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemma-4-31b-it',
    ]);
    const next = getNextFallbackModel('gemini-2.5-flash', tried);
    expect(next).toBeNull();
  });
});

describe('compactBodyForOverload', () => {
  test('compacts body with many messages', () => {
    const contents = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `Message ${i}: ${'x'.repeat(100)}` }],
    }));
    const body = { contents };
    const compacted = compactBodyForOverload(body);
    expect(compacted.contents.length).toBeLessThan(contents.length);
    expect(compacted.contents.length).toBe(7); // 2 head + 1 compacted + 4 tail
  });

  test('does not compact short body', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const compacted = compactBodyForOverload(body);
    expect(compacted.contents.length).toBe(1);
  });

  test('preserves non-contents fields', () => {
    const body = {
      contents: Array.from({ length: 10 }, () => ({ role: 'user', parts: [{ text: 'x' }] })),
      generationConfig: { temperature: 0.5 },
    };
    const compacted = compactBodyForOverload(body);
    expect(compacted.generationConfig).toEqual({ temperature: 0.5 });
  });
});

describe('detectTokenPressure', () => {
  test('low pressure for small body', () => {
    const body = { contents: [{ parts: [{ text: 'hello' }] }] };
    const result = detectTokenPressure(body);
    expect(result.high).toBe(false);
  });

  test('high pressure for very large body', () => {
    const body = { contents: [{ parts: [{ text: 'x'.repeat(1_000_000) }] }] };
    const result = detectTokenPressure(body);
    expect(result.high).toBe(true);
  });

  test('checks messages array (Anthropic format)', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }] };
    const result = detectTokenPressure(body);
    expect(result.high).toBe(true);
  });
});

describe('computeOverloadBackoff', () => {
  test('attempt 1 returns ~2s', () => {
    const ms = computeOverloadBackoff(1);
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThan(3000);
  });

  test('attempt 2 returns ~5s', () => {
    const ms = computeOverloadBackoff(2);
    expect(ms).toBeGreaterThanOrEqual(5000);
    expect(ms).toBeLessThan(6000);
  });

  test('attempt 3+ returns ~10s', () => {
    const ms = computeOverloadBackoff(3);
    expect(ms).toBeGreaterThanOrEqual(10000);
    expect(ms).toBeLessThan(11000);
  });
});

describe('recoverFromOverload', () => {
  test('recovery returns new model and key when available', async () => {
    const result = await recoverFromOverload({
      currentModel: 'gemini-2.5-flash',
      currentKeyId: 'k-overloaded',
      triedModels: new Set(['gemini-2.5-flash']),
      attempt: 1,
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
      userId: 'user1',
    });
    expect(result.recovered).toBe(true);
    expect(result.newModel).toBeTruthy();
    expect(result.backoffMs).toBeGreaterThanOrEqual(2000);
  });

  test('recovery returns recovered=false when all models exhausted', async () => {
    const { getHealthiestKeyObj } = require('../lib/key-manager');
    getHealthiestKeyObj.mockResolvedValueOnce(null);
    getHealthiestKeyObj.mockResolvedValueOnce(null);
    getHealthiestKeyObj.mockResolvedValueOnce(null);
    getHealthiestKeyObj.mockResolvedValueOnce(null);

    const result = await recoverFromOverload({
      currentModel: 'gemini-2.5-flash',
      currentKeyId: 'k1',
      triedModels: new Set([
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview',
        'gemma-4-31b-it',
      ]),
      attempt: 4,
      body: { contents: [] },
    });
    expect(result.newModel).toBeNull();
  });
});

describe('stream state preservation (Phase 9)', () => {
  test('savePartialStreamState and getPartialStreamState roundtrip', async () => {
    const state = {
      model: 'gemini-2.5-flash',
      keyId: 'k1',
      chunksReceived: 5,
      lastChunkText: 'partial output...',
      bodySnapshot: { contents: [] },
    };
    await savePartialStreamState('req-1', state);
    const loaded = await getPartialStreamState('req-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe('gemini-2.5-flash');
    expect(loaded!.chunksReceived).toBe(5);
  });

  test('unknown request returns null', async () => {
    const result = await getPartialStreamState('nonexistent');
    expect(result).toBeNull();
  });
});
