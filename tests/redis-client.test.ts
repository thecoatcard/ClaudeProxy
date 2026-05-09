/**
 * tests/redis-client.test.ts
 *
 * Unit tests for lib/redis/client.ts.
 * All tests mock ioredis so no live Redis connection is needed.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// ─── Mock ioredis ──────────────────────────────────────────────────────────────

interface MockPipe {
  commands: Array<{ cmd: string; args: unknown[] }>;
  _results: ([Error | null, unknown])[];
  get: (key: string) => MockPipe;
  set: (...args: unknown[]) => MockPipe;
  setex: (...args: unknown[]) => MockPipe;
  del: (...args: unknown[]) => MockPipe;
  incr: (key: string) => MockPipe;
  incrby: (key: string, n: number) => MockPipe;
  expire: (key: string, ttl: number) => MockPipe;
  hget: (key: string, field: string) => MockPipe;
  hgetall: (key: string) => MockPipe;
  hset: (...args: unknown[]) => MockPipe;
  hincrby: (key: string, field: string, n: number) => MockPipe;
  hdel: (...args: unknown[]) => MockPipe;
  zadd: (...args: unknown[]) => MockPipe;
  zrem: (...args: unknown[]) => MockPipe;
  sadd: (...args: unknown[]) => MockPipe;
  srem: (...args: unknown[]) => MockPipe;
  lpush: (...args: unknown[]) => MockPipe;
  rpush: (...args: unknown[]) => MockPipe;
  ltrim: (key: string, start: number, stop: number) => MockPipe;
  exec: () => Promise<[Error | null, unknown][]>;
}

let mockPipeResults: ([Error | null, unknown])[] = [];

const mockPipe: MockPipe = {
  commands: [],
  _results: [],
  get(key) { this.commands.push({ cmd: 'get', args: [key] }); return this; },
  set(...args) { this.commands.push({ cmd: 'set', args }); return this; },
  setex(...args) { this.commands.push({ cmd: 'setex', args }); return this; },
  del(...args) { this.commands.push({ cmd: 'del', args }); return this; },
  incr(key) { this.commands.push({ cmd: 'incr', args: [key] }); return this; },
  incrby(key, n) { this.commands.push({ cmd: 'incrby', args: [key, n] }); return this; },
  expire(key, ttl) { this.commands.push({ cmd: 'expire', args: [key, ttl] }); return this; },
  hget(key, field) { this.commands.push({ cmd: 'hget', args: [key, field] }); return this; },
  hgetall(key) { this.commands.push({ cmd: 'hgetall', args: [key] }); return this; },
  hset(...args) { this.commands.push({ cmd: 'hset', args }); return this; },
  hincrby(key, field, n) { this.commands.push({ cmd: 'hincrby', args: [key, field, n] }); return this; },
  hdel(...args) { this.commands.push({ cmd: 'hdel', args }); return this; },
  zadd(...args) { this.commands.push({ cmd: 'zadd', args }); return this; },
  zrem(...args) { this.commands.push({ cmd: 'zrem', args }); return this; },
  sadd(...args) { this.commands.push({ cmd: 'sadd', args }); return this; },
  srem(...args) { this.commands.push({ cmd: 'srem', args }); return this; },
  lpush(...args) { this.commands.push({ cmd: 'lpush', args }); return this; },
  rpush(...args) { this.commands.push({ cmd: 'rpush', args }); return this; },
  ltrim(key, start, stop) { this.commands.push({ cmd: 'ltrim', args: [key, start, stop] }); return this; },
  async exec() { return mockPipeResults; },
};

const mockIoRedis: Record<string, unknown> = {
  get: async (_key: string) => null,
  set: async (..._args: unknown[]) => 'OK',
  setex: async (..._args: unknown[]) => 'OK',
  del: async (..._args: unknown[]) => 0,
  incr: async (_key: string) => 0,
  incrby: async (_key: string, _n: number) => 0,
  expire: async (_key: string, _ttl: number) => 1,
  exists: async (..._args: unknown[]) => 0,
  hget: async (_key: string, _field: string) => null,
  hgetall: async (_key: string) => null,
  hset: async (..._args: unknown[]) => 0,
  hincrby: async (_key: string, _field: string, _n: number) => 0,
  hdel: async (..._args: unknown[]) => 0,
  zadd: async (..._args: unknown[]) => 0,
  zrange: async (_key: string, _start: number, _stop: number) => [] as string[],
  zrevrange: async (_key: string, _start: number, _stop: number) => [] as string[],
  zrem: async (..._args: unknown[]) => 0,
  zcard: async (_key: string) => 0,
  sadd: async (..._args: unknown[]) => 0,
  smembers: async (_key: string) => [] as string[],
  srem: async (..._args: unknown[]) => 0,
  lrange: async (_key: string, _start: number, _stop: number) => [] as string[],
  lpush: async (..._args: unknown[]) => 0,
  rpush: async (..._args: unknown[]) => 0,
  ltrim: async (..._args: unknown[]) => 'OK',
  pipeline: () => mockPipe,
  on: () => mockIoRedis,
  quit: async () => 'OK',
  disconnect: () => undefined,
};

// Patch the module resolution to inject mock.
// We use the internal getClient() through monkey-patching the ioredis module.
// Since we can't easily mock ESM modules in node:test, we test the wrapper logic
// by instantiating RedisClient after patching the underlying client factory.

// ─── Helper: build a fresh RedisClient backed by a mock ──────────────────────

async function buildRedisClient() {
  // Dynamic import so the module isn't cached from previous tests.
  // We need to exercise the wrapper logic, so we import the class and
  // create an instance using a mock-backed getClient approach.
  // For simplicity, we directly test the API-translation logic here.
  
  const { RedisPipeline, RedisClient } = await import('../lib/redis/client.js');
  return { RedisPipeline, RedisClient };
}

// ─── Tests for RedisPipeline ──────────────────────────────────────────────────

describe('RedisPipeline', () => {
  beforeEach(() => {
    mockPipe.commands = [];
    mockPipeResults = [];
  });

  it('translates zadd({score, member}) to positional args', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    pipe.zadd('key_pool', { score: 100, member: 'key-1' });
    const zadd = mockPipe.commands.find((c) => c.cmd === 'zadd');
    assert.ok(zadd, 'zadd command should have been queued');
    assert.deepEqual(zadd!.args, ['key_pool', 100, 'key-1']);
  });

  it('exec() unwraps [Error, value][] → value[]', async () => {
    mockPipeResults = [
      [null, 42],
      [null, 'hello'],
      [new Error('fail'), 'ignored'],
      [null, { field: 'val' }],
    ];
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    const results = await pipe.exec();
    assert.deepEqual(results, [42, 'hello', null, { field: 'val' }]);
  });

  it('exec() normalises empty hgetall {} → null', async () => {
    mockPipeResults = [[null, {}]];
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    const results = await pipe.exec();
    assert.deepEqual(results, [null]);
  });

  it('exec() returns [] when pipe.exec() returns null', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const nullPipe = { ...mockPipe, exec: async () => null } as unknown as ReturnType<import('ioredis').Redis['pipeline']>;
    const pipe = new RedisPipeline(nullPipe);
    const results = await pipe.exec();
    assert.deepEqual(results, []);
  });

  it('set() passes EX when opts.ex is set', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    pipe.set('k', 'v', { ex: 60 });
    const cmd = mockPipe.commands.find((c) => c.cmd === 'set');
    assert.ok(cmd);
    assert.deepEqual(cmd!.args, ['k', 'v', 'EX', 60]);
  });

  it('set() without ex does not add EX flag', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    pipe.set('k', 'v');
    const cmd = mockPipe.commands.find((c) => c.cmd === 'set');
    assert.ok(cmd);
    assert.deepEqual(cmd!.args, ['k', 'v']);
  });

  it('set() serialises non-string values as JSON', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    pipe.set('k', { foo: 1 });
    const cmd = mockPipe.commands.find((c) => c.cmd === 'set');
    assert.ok(cmd);
    assert.equal(cmd!.args[1], '{"foo":1}');
  });

  it('hincrby chains correctly', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    const result = pipe.incr('a').incrby('b', 5).hincrby('h', 'f', 1);
    assert.equal(result, pipe, 'methods should be chainable');
    assert.equal(mockPipe.commands.length, 3);
  });
});

// ─── Tests for zadd argument translation (parseZaddArg) ──────────────────────

describe('RedisClient zadd argument validation', () => {
  it('throws for invalid zadd argument', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    assert.throws(
      () => pipe.zadd('key', null as unknown as { score: number; member: string }),
      TypeError
    );
  });
});

// ─── Tests for normalizeHash ──────────────────────────────────────────────────

describe('RedisPipeline hgetall normalisation', () => {
  it('exec() passes through non-empty hgetall objects', async () => {
    mockPipeResults = [[null, { status: 'healthy', score: '100' }]];
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    const results = await pipe.exec();
    assert.deepEqual(results, [{ status: 'healthy', score: '100' }]);
  });

  it('exec() normalises null hgetall results to null', async () => {
    mockPipeResults = [[null, null]];
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    const results = await pipe.exec();
    assert.deepEqual(results, [null]);
  });
});

// ─── Tests for lpush serialisation ────────────────────────────────────────────

describe('RedisPipeline lpush serialisation', () => {
  it('converts numeric values to strings', async () => {
    const { RedisPipeline } = await buildRedisClient();
    const pipe = new RedisPipeline(mockPipe as unknown as ReturnType<import('ioredis').Redis['pipeline']>);
    pipe.lpush('list', 42, 'hello', 3.14);
    const cmd = mockPipe.commands.find((c) => c.cmd === 'lpush');
    assert.ok(cmd);
    assert.deepEqual(cmd!.args, ['list', '42', 'hello', '3.14']);
  });
});
