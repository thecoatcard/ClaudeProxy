export {};

jest.mock('@/lib/auth', () => ({
  validateAdminKey: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/admin-cache', () => ({
  cachedAdminResponse: jest.fn((_key: string, compute: () => Promise<unknown>) => compute()),
}));

const redisMock = {
  get: jest.fn(async (key: string) => {
    if (key === 'stats:requests') return '42';
    if (key === 'stats:errors') throw new Error('redis unavailable');
    return null;
  }),
  lrange: jest.fn(async () => []),
  hgetall: jest.fn(async () => null),
};

jest.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

describe('admin stats route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns partial stats when one Redis read fails', async () => {
    const { GET } = await import('@/app/api/admin/stats/route');
    const res = await GET(new Request('http://localhost/api/admin/stats'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requests).toBe(42);
    expect(body.errors).toBe(0);
    expect(Array.isArray(body.daily)).toBe(true);
    expect(body.daily).toHaveLength(14);
  });
});