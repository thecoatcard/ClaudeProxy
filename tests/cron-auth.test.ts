export {};

const redisMock = {
  get: jest.fn(),
  hset: jest.fn(),
  zrange: jest.fn(),
  hgetall: jest.fn(),
  zadd: jest.fn(),
};

jest.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

function makeRequest(token?: string) {
  return new Request('http://localhost/api/cron/metrics', {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe('cron authentication guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRON_SECRET;
  });

  it('fails closed when the cron secret is missing', async () => {
    const { GET } = await import('@/app/api/cron/metrics/route');
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(503);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token', async () => {
    process.env.CRON_SECRET = 'expected';
    const { GET } = await import('@/app/api/cron/metrics/route');
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
    expect(redisMock.get).not.toHaveBeenCalled();
  });
});
