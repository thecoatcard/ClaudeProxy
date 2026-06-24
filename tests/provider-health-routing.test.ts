/**
 * tests/provider-health-routing.test.ts
 *
 * Unit tests for Phase 8 — Provider Health-Aware Model Ordering.
 * Covers: recordModelHealth, getModelHealth, getHealthAwareFallbackChain, getNextFallbackModelHealthAware.
 */

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, _opts?: any) => { store.set(key, value); return 'OK'; }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    },
  };
});

import { redis } from '../lib/redis';
import {
  recordModelHealth,
  getModelHealth,
  getHealthAwareFallbackChain,
  getNextFallbackModelHealthAware,
} from '../lib/recovery/overload-recovery';

const mockRedis = redis as any;

beforeEach(() => {
  mockRedis._store.clear();
  jest.clearAllMocks();
});

describe('recordModelHealth', () => {
  it('stores a health record in Redis', async () => {
    await recordModelHealth('gemini-2.5-flash', 'success', 1500);
    expect(mockRedis.set).toHaveBeenCalled();
    const stored = JSON.parse(mockRedis._store.get('provider:health:gemini-2.5-flash'));
    expect(stored.successes).toBe(1);
    expect(stored.failures).toBe(0);
    expect(stored.totalLatencyMs).toBe(1500);
  });

  it('increments failures on error', async () => {
    await recordModelHealth('gemini-2.5-flash', 'error', 500);
    await recordModelHealth('gemini-2.5-flash', 'error', 500);
    const stored = JSON.parse(mockRedis._store.get('provider:health:gemini-2.5-flash'));
    expect(stored.failures).toBe(2);
  });

  it('increments overloadCount on overload', async () => {
    await recordModelHealth('gemini-2.5-flash', 'overload', 0);
    const stored = JSON.parse(mockRedis._store.get('provider:health:gemini-2.5-flash'));
    expect(stored.overloadCount).toBe(1);
    expect(stored.failures).toBe(1);
  });

  it('resets failures to 0 on success', async () => {
    await recordModelHealth('gemini-2.5-flash', 'error');
    await recordModelHealth('gemini-2.5-flash', 'error');
    await recordModelHealth('gemini-2.5-flash', 'success');
    const stored = JSON.parse(mockRedis._store.get('provider:health:gemini-2.5-flash'));
    expect(stored.failures).toBe(0);
    expect(stored.successes).toBe(1);
  });

  it('does not throw on Redis error (best-effort)', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));
    await expect(recordModelHealth('gemini-2.5-flash', 'success')).resolves.not.toThrow();
  });
});

describe('getModelHealth', () => {
  it('returns zero-initialized record for unknown model', async () => {
    const health = await getModelHealth('unknown-model');
    expect(health.failures).toBe(0);
    expect(health.successes).toBe(0);
    expect(health.overloadCount).toBe(0);
  });

  it('returns stored health record', async () => {
    await recordModelHealth('gemini-flash-latest', 'success', 2000);
    const health = await getModelHealth('gemini-flash-latest');
    expect(health.successes).toBe(1);
    expect(health.totalLatencyMs).toBe(2000);
  });
});

describe('getHealthAwareFallbackChain', () => {
  it('returns models not in triedModels, excluding current', async () => {
    const tried = new Set(['gemini-3-flash-preview']);
    const chain = await getHealthAwareFallbackChain('gemini-2.5-flash', tried);
    expect(chain).not.toContain('gemini-2.5-flash');
    expect(chain).not.toContain('gemini-3-flash-preview');
  });

  it('prefers healthier (lower failure count) models', async () => {
    // Mark gemini-3.1-flash-lite-preview as having lots of failures
    await recordModelHealth('gemini-3.1-flash-lite-preview', 'overload');
    await recordModelHealth('gemini-3.1-flash-lite-preview', 'overload');
    await recordModelHealth('gemini-3.1-flash-lite-preview', 'overload');
    // gemini-3-flash-preview is fresh (no failures)

    const chain = await getHealthAwareFallbackChain('gemini-2.5-flash', new Set());
    // The unhealthy model should appear AFTER the healthy one
    const liteIdx = chain.indexOf('gemini-3.1-flash-lite-preview');
    const flashIdx = chain.indexOf('gemini-3-flash-preview');
    // Both should be in chain
    expect(liteIdx).toBeGreaterThanOrEqual(0);
    expect(flashIdx).toBeGreaterThanOrEqual(0);
    // Healthy model should come before degraded model
    expect(flashIdx).toBeLessThan(liteIdx);
  });

  it('places Gemma models after Gemini models when all are healthy', async () => {
    const chain = await getHealthAwareFallbackChain('gemini-2.5-flash', new Set());
    const gemmaModels = chain.filter((m) => m.startsWith('gemma-'));
    const geminiModels = chain.filter((m) => m.startsWith('gemini-'));
    // All Gemini models should appear before all Gemma models
    const lastGeminiIdx = Math.max(...geminiModels.map((m) => chain.indexOf(m)));
    const firstGemmaIdx = Math.min(...gemmaModels.map((m) => chain.indexOf(m)));
    expect(lastGeminiIdx).toBeLessThan(firstGemmaIdx);
  });

  it('returns empty array when all models are tried', async () => {
    const allModels = new Set([
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-flash-latest',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
    ]);
    const chain = await getHealthAwareFallbackChain('gemini-2.5-flash', allModels);
    expect(chain).toHaveLength(0);
  });
});

describe('getNextFallbackModelHealthAware', () => {
  it('returns a model string or null', async () => {
    const model = await getNextFallbackModelHealthAware('gemini-2.5-flash', new Set());
    expect(typeof model === 'string' || model === null).toBe(true);
  });

  it('returns null when all models are tried', async () => {
    const allModels = new Set([
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-flash-latest',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
    ]);
    const model = await getNextFallbackModelHealthAware('gemini-2.5-flash', allModels);
    expect(model).toBeNull();
  });

  it('falls back to static chain on Redis error', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis down'));
    const model = await getNextFallbackModelHealthAware('gemini-2.5-flash', new Set());
    // Should still return a model (from static chain)
    expect(typeof model).toBe('string');
    mockRedis.get.mockRestore();
  });
});
