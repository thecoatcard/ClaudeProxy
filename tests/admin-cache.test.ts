/**
 * tests/admin-cache.test.ts
 * Tests for admin API response caching.
 */

import { cachedAdminResponse, invalidateAdminCache, invalidateAllAdminCache } from '../lib/admin-cache';

beforeEach(() => {
  invalidateAllAdminCache();
});

describe('cachedAdminResponse', () => {
  test('calls compute on first access', async () => {
    const compute = jest.fn().mockResolvedValue({ value: 42 });
    const result = await cachedAdminResponse('test:key', compute);
    expect(result).toEqual({ value: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  test('returns cached value on second access', async () => {
    const compute = jest.fn().mockResolvedValue({ value: 42 });
    await cachedAdminResponse('test:key', compute);
    const result = await cachedAdminResponse('test:key', compute);
    expect(result).toEqual({ value: 42 });
    expect(compute).toHaveBeenCalledTimes(1); // not called again
  });

  test('different keys are cached independently', async () => {
    const compute1 = jest.fn().mockResolvedValue('a');
    const compute2 = jest.fn().mockResolvedValue('b');
    const r1 = await cachedAdminResponse('key1', compute1);
    const r2 = await cachedAdminResponse('key2', compute2);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
  });

  test('invalidateAdminCache forces recompute', async () => {
    const compute = jest.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    await cachedAdminResponse('key', compute);
    invalidateAdminCache('key');
    const result = await cachedAdminResponse('key', compute);
    expect(result).toBe('second');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test('invalidateAllAdminCache clears everything', async () => {
    const compute = jest.fn()
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');
    await cachedAdminResponse('key', compute);
    invalidateAllAdminCache();
    const result = await cachedAdminResponse('key', compute);
    expect(result).toBe('v2');
  });

  test('expired entries are recomputed', async () => {
    const compute = jest.fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new');
    // Use 1ms TTL for instant expiration
    await cachedAdminResponse('key', compute, 1);
    // Wait 5ms for expiration
    await new Promise(r => setTimeout(r, 5));
    const result = await cachedAdminResponse('key', compute, 1);
    expect(result).toBe('new');
  });
});
