/**
 * tests/admin-api-performance.test.ts
 *
 * Verifies Redis N+1 patterns are fixed — admin APIs use pipeline instead of serial loops.
 */

// Mock nanoid (ESM)
jest.mock('nanoid', () => ({ nanoid: () => 'test_id_123' }));

const mockPipeline = {
  hgetall: jest.fn().mockReturnThis(),
  hget: jest.fn().mockReturnThis(),
  get: jest.fn().mockReturnThis(),
  lrange: jest.fn().mockReturnThis(),
  hset: jest.fn().mockReturnThis(),
  zadd: jest.fn().mockReturnThis(),
  exists: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

jest.mock('@/lib/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    hgetall: jest.fn().mockResolvedValue({}),
    hset: jest.fn().mockResolvedValue(1),
    zrange: jest.fn().mockResolvedValue(['key_1', 'key_2', 'key_3']),
    zadd: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue(['token_1', 'token_2']),
    lrange: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue('PONG'),
    pipeline: jest.fn().mockReturnValue(mockPipeline),
  },
}));

jest.mock('@/lib/auth', () => ({
  validateAdminKey: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/admin-cache', () => ({
  cachedAdminResponse: jest.fn((_key: string, compute: () => Promise<unknown>) => compute()),
}));

import { NextRequest } from 'next/server';

function makeReq(path: string) {
  return new NextRequest(new URL(`http://localhost${path}`));
}

describe('Admin API N+1 Fix: uses pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPipeline.exec.mockResolvedValue([
      { status: 'healthy', key: 'gemini-key-1' },
      { status: 'healthy', key: 'gemini-key-2' },
      { status: 'cooldown', key: 'gemini-key-3' },
    ]);
  });

  test('keys GET uses pipeline instead of N serial hgetall', async () => {
    const { GET } = await import('@/app/api/admin/keys/route');
    const res = await GET(makeReq('/api/admin/keys'));
    expect(res).toBeInstanceOf(Response);

    const { redis } = require('@/lib/redis');
    // Should call pipeline(), NOT individual hgetall()
    expect(redis.pipeline).toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  test('user-keys GET uses pipeline instead of N serial hgetall', async () => {
    const { GET } = await import('@/app/api/admin/user-keys/route');
    const res = await GET(makeReq('/api/admin/user-keys'));
    expect(res).toBeInstanceOf(Response);

    const { redis } = require('@/lib/redis');
    expect(redis.pipeline).toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  test('keys activate-all uses batched pipeline writes', async () => {
    const { PATCH } = await import('@/app/api/admin/keys/route');
    const req = makeReq('/api/admin/keys?action=activate-all');
    const res = await PATCH(req);
    expect(res).toBeInstanceOf(Response);

    const { redis } = require('@/lib/redis');
    // Two pipeline calls: one for reads, one for writes
    expect(redis.pipeline).toHaveBeenCalledTimes(2);
  });
});
