export {};

const counters = new Map<string, number>();
const values = new Map<string, string>();

const redisMock = {
  incr: jest.fn(async (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  }),
  expire: jest.fn(async () => 1),
  setex: jest.fn(async (key: string, _ttl: number, value: string) => {
    values.set(key, value);
  }),
  del: jest.fn(async (key: string) => {
    counters.delete(key);
    values.delete(key);
    return 1;
  }),
};

jest.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

function makeRequest(body: unknown, ip = '127.0.0.1'): Request {
  return new Request('http://localhost/api/admin/session/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
}

describe('admin session login route', () => {
  beforeEach(() => {
    counters.clear();
    values.clear();
    jest.clearAllMocks();
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'secret';
  });

  it('fails closed when admin auth is not configured', async () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    const { POST } = await import('@/app/api/admin/session/login/route');

    const res = await POST(makeRequest({ email: 'admin@example.com', password: 'secret' }));
    expect(res.status).toBe(503);
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('rate limits repeated invalid login attempts', async () => {
    const { POST } = await import('@/app/api/admin/session/login/route');

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await POST(makeRequest({ email: 'admin@example.com', password: 'wrong' }));
      expect(res.status).toBe(401);
    }

    const blocked = await POST(makeRequest({ email: 'admin@example.com', password: 'wrong' }));
    expect(blocked.status).toBe(429);
    expect(redisMock.setex).not.toHaveBeenCalled();
  });

  it('creates a session and clears the attempt counter on success', async () => {
    const { POST } = await import('@/app/api/admin/session/login/route');

    const res = await POST(makeRequest({ email: 'admin@example.com', password: 'secret' }, '10.0.0.5'));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain('admin_session=');
    expect(redisMock.setex).not.toHaveBeenCalled();
    expect(redisMock.del).toHaveBeenCalledWith('admin:login:attempts:10.0.0.5');
  });
});
