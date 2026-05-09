/**
 * tests/route-contract.test.ts
 *
 * Verify all admin route handlers return proper Response objects,
 * never boolean, null, or undefined.
 */

// Mock nanoid (ESM)
jest.mock('nanoid', () => ({ nanoid: () => 'test_id_123' }));

// Mock Redis
jest.mock('@/lib/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    hget: jest.fn().mockResolvedValue(null),
    hset: jest.fn().mockResolvedValue(1),
    zrange: jest.fn().mockResolvedValue([]),
    zadd: jest.fn().mockResolvedValue(1),
    zrem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(1),
    lrange: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(0),
    ping: jest.fn().mockResolvedValue('PONG'),
    scan: jest.fn().mockResolvedValue(['0', []]),
    pipeline: jest.fn().mockReturnValue({
      hgetall: jest.fn().mockReturnThis(),
      hget: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      lrange: jest.fn().mockReturnThis(),
      exists: jest.fn().mockReturnThis(),
      hset: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  },
}));

jest.mock('@/lib/auth', () => ({
  validateAdminKey: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/activity', () => ({
  clearActivity: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logging/event-store', () => ({
  getRecentEvents: jest.fn().mockResolvedValue([]),
  getRequestEvents: jest.fn().mockResolvedValue([]),
  getEventSummary: jest.fn().mockResolvedValue({}),
  clearEvents: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logging/timeline-builder', () => ({
  buildTimeline: jest.fn().mockReturnValue([]),
  getRequestDuration: jest.fn().mockReturnValue(0),
  getPhasesSummary: jest.fn().mockReturnValue({}),
}));

jest.mock('@/lib/logging/log-dedup', () => ({
  getDedupStats: jest.fn().mockReturnValue({}),
}));

jest.mock('@/lib/admin-cache', () => ({
  cachedAdminResponse: jest.fn((_key: string, compute: () => Promise<unknown>) => compute()),
}));

import { NextRequest } from 'next/server';

function makeReq(path: string, method = 'GET') {
  return new NextRequest(new URL(`http://localhost${path}`), { method });
}

describe('Route Contract: admin routes return Response', () => {
  test('logs GET returns Response', async () => {
    const { GET } = await import('@/app/api/admin/logs/route');
    const res = await GET(makeReq('/api/admin/logs'));
    expect(res).toBeInstanceOf(Response);
    expect(typeof res).not.toBe('boolean');
  });

  test('logs DELETE returns Response', async () => {
    const { DELETE } = await import('@/app/api/admin/logs/route');
    const res = await DELETE(makeReq('/api/admin/logs', 'DELETE'));
    expect(res).toBeInstanceOf(Response);
  });

  test('keys GET returns Response', async () => {
    const { GET } = await import('@/app/api/admin/keys/route');
    const res = await GET(makeReq('/api/admin/keys'));
    expect(res).toBeInstanceOf(Response);
    const body = await res.json();
    expect(body).toHaveProperty('keys');
  });

  test('user-keys GET returns Response', async () => {
    const { GET } = await import('@/app/api/admin/user-keys/route');
    const res = await GET(makeReq('/api/admin/user-keys'));
    expect(res).toBeInstanceOf(Response);
    const body = await res.json();
    expect(body).toHaveProperty('userKeys');
  });
});
