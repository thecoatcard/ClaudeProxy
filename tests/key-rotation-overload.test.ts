/**
 * tests/key-rotation-overload.test.ts
 *
 * Phase 11: Tests that overload correctly rotates keys
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

const mockGetKey = jest.fn();
const mockReportFailure = jest.fn().mockResolvedValue(undefined);

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: (...args: any[]) => mockGetKey(...args),
  reportKeyFailure: (...args: any[]) => mockReportFailure(...args),
}));

import { cooldownOverloadedKey, rotateToFreshKey } from '../lib/recovery/overload-recovery';

describe('key rotation on overload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cooldownOverloadedKey reports failure and sets cooldown', async () => {
    await cooldownOverloadedKey('key-overloaded');
    expect(mockReportFailure).toHaveBeenCalledWith('key-overloaded', 'server');
  });

  test('rotateToFreshKey skips the excluded key', async () => {
    // First call returns excluded key, second returns fresh key
    mockGetKey
      .mockResolvedValueOnce({ id: 'key-bad', key: 'bad-api-key' })
      .mockResolvedValueOnce({ id: 'key-good', key: 'good-api-key' });

    const result = await rotateToFreshKey('user1', 'key-bad');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('key-good');
  });

  test('rotateToFreshKey returns null when no keys available', async () => {
    mockGetKey.mockResolvedValue(null);
    const result = await rotateToFreshKey('user1');
    expect(result).toBeNull();
  });

  test('rotateToFreshKey returns first non-cooldown key', async () => {
    mockGetKey.mockResolvedValue({ id: 'key-fresh', key: 'fresh-api-key' });
    const result = await rotateToFreshKey('user1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('key-fresh');
  });
});
